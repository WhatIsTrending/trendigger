// Enrich：为缺少简介的关键词生成简介（当地语言），并把非英语简介翻译成英文。
// 用法:
//   node src/enrich.js                       # 今天，所有 geos
//   node src/enrich.js US JP                 # 只指定 geo
//   node src/enrich.js --date 2026-04-25 US
//   node src/enrich.js --keyword "anthony edwards" --geo US   # 强制单条重生成
//   node src/enrich.js --limit 20            # 本次最多跑多少条（省配额）
//   node src/enrich.js --top 50              # 每个 geo 只处理 volume 前 50（默认 50，0=不限）
//   node src/enrich.js --only-lang en        # 只补英文版本（翻译现有当地 intro）
//   node src/enrich.js --only-lang local     # 只补当地语言版本
//   node src/enrich.js --backfill-en         # 扫描所有缺 intro_en 的历史行并翻译
//   node src/enrich.js --azure-top 10        # 每个非英语 geo 前 10 走 Azure，其余走 Google（默认 10）
//
// 逻辑：
//   1) 从 trend_snapshots 取当天每个 (geo, keyword) 的峰值快照（含 news_json）
//   2) LEFT JOIN keyword_intro：判断还缺哪种语言
//        - 当地语言（geoMeta.lang）缺失 → 生成当地语言
//        - 当地语言非 en 且英文缺失     → 翻译当地 intro 成英文（分层路由）
//        - 当地语言 = en 时只生成一份，存 intro，intro_en 留空（渲染时回退）
//   3) 翻译分层（assignTiers）：每个非英语 geo 内按 volume 排序，
//        top-N（--azure-top，默认 10）→ Azure Translator（高质量，免费层 2M 字符/月）
//        其余                          → Google 免费 gtx 端点（与 googletrans 同源）
//      英语 geo（lang='en'）不翻译。
//   4) COALESCE upsert：只更新本次生成/翻译过的字段，不覆盖已有的另一种语言
//   5) 失败不阻断整轮，记录到日志

import { queryAll, executeBatch } from './db.js';
import { generateIntro } from './providers.js';
import { translate } from './translate.js';
import { GEOS, GEO_BY_CODE } from './geos.js';

// 英语 geo 中仍需把 intro 翻译成 intro_en 的特例。
// 原因：snippet provider 不保证返回英文（常返回新闻源语种，如 real madrid 的西班牙语），
// 这些 en geo 的 intro_en 为空，页面会显示外语。IN 暂列入；其余 en geo 不动。
// 这些 geo 始终走 Google 免费翻译，不消耗 Azure 配额。
const EN_GEOS_NEED_EN_INTRO = new Set(['IN']);

const args = process.argv.slice(2);

const topRaw = argOf('--top');
const onlyLangRaw = argOf('--only-lang');
const flags = {
  date: argOf('--date'),
  keyword: argOf('--keyword'),
  geo: argOf('--geo'),
  limit: Number(argOf('--limit') ?? 0) || 0,
  top: topRaw === undefined ? 50 : (Number(topRaw) || 0),
  concurrency: Number(argOf('--concurrency') ?? 8) || 8,
  force: args.includes('--force'),
  onlyLang: onlyLangRaw ? onlyLangRaw.toLowerCase() : null,
  backfillEn: args.includes('--backfill-en'),
  azureTop: Number(argOf('--azure-top') ?? process.env.AZURE_TOP_N ?? 10) || 0,
};

function argOf(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const positional = args.filter((a, i) => {
  if (a.startsWith('--')) return false;
  const prev = args[i - 1];
  if (prev && prev.startsWith('--') && !['--force'].includes(prev)) return false;
  return true;
});

const targetGeos = flags.geo
  ? [GEO_BY_CODE[flags.geo]].filter(Boolean)
  : positional.length
    ? positional.map((c) => GEO_BY_CODE[c]).filter(Boolean)
    : GEOS;

if (flags.geo && !GEO_BY_CODE[flags.geo]) {
  console.error(`Unknown geo: ${flags.geo}`);
  process.exit(1);
}

if (flags.onlyLang && !['en', 'local'].includes(flags.onlyLang)) {
  console.error(`--only-lang must be 'en' or 'local'`);
  process.exit(1);
}

// --keyword 模式：单条生成，不管 date
if (flags.keyword) {
  const geo = flags.geo ?? 'US';
  const geoMeta = GEO_BY_CODE[geo];
  if (!geoMeta) { console.error(`Unknown geo: ${geo}`); process.exit(1); }

  const rows = await queryAll(
    `SELECT news_json FROM (
       SELECT s.news_json,
              ROW_NUMBER() OVER (
                PARTITION BY s.geo, s.query
                ORDER BY s.date DESC, s.search_volume DESC, s.observed_at DESC
              ) AS rn
         FROM trend_snapshots s
        WHERE s.query = ? AND s.geo = ?
     ) WHERE rn = 1`,
    [flags.keyword, geo],
  );
  const news = rows[0]?.news_json ? safeJson(rows[0].news_json, []) : [];
  const c = makeCandidate({ keyword: flags.keyword, geo, news }, geoMeta, null, null, null, true);
  const r = await runOne(c);
  await flushBatch([r]);
  const tags = [c.doLocal && c.localLang, c.doEn && 'en'].filter(Boolean).join(',');
  console.log(`Done. [${geo}] "${flags.keyword}" langs=${tags}`);
  process.exit(0);
}

// 批量模式
const candidates = flags.backfillEn
  ? await collectBackfillEn(targetGeos)
  : await collectCandidates(targetGeos, flags.date, flags.force, flags.onlyLang);
// 给每个 doEn 候选分配翻译分层：每个 geo 内按 volume 降序，top-N → azure，其余 → google。
assignTiers(candidates, flags.azureTop);
const topped = flags.top > 0 && !flags.backfillEn ? applyTopPerGeo(candidates, flags.top) : candidates;
const list = flags.limit ? topped.slice(0, flags.limit) : topped;

const tierCounts = list.reduce(
  (acc, c) => { if (c.doEn && c.tier) acc[c.tier] = (acc[c.tier] || 0) + 1; return acc; },
  { azure: 0, google: 0 },
);

console.log(
  flags.backfillEn
    ? `Backfill intro_en: geos=${targetGeos.map((g) => g.code).join(',')}` +
      `, candidates=${candidates.length}, will process=${list.length}` +
      ` (azure=${tierCounts.azure}, google=${tierCounts.google}, azure-top=${flags.azureTop || 'off'})`
    : `Enrich: ${flags.date ? 'date=' + flags.date : 'latest per geo'}, geos=${targetGeos.map((g) => g.code).join(',')}` +
      `, candidates=${candidates.length}` +
      (flags.top > 0 ? `, top=${flags.top}/geo (${topped.length} after top)` : '') +
      `, will process=${list.length} (azure=${tierCounts.azure}, google=${tierCounts.google}, azure-top=${flags.azureTop || 'off'})` +
      (flags.force ? ' (force regen)' : '') +
      (flags.onlyLang ? ` (only-lang=${flags.onlyLang})` : ''),
);

let ok = 0, fail = 0;
/** @type {{keyword:string,geo:string,lang:string,intro:string|null,intro_en:string|null,model:string|null}[]} */
const results = [];
const FLUSH_EVERY = 50;

await runPool(list, flags.concurrency, async (c) => {
  try {
    const r = await runOne(c);
    results.push(r);
    ok++;
    if (results.length >= FLUSH_EVERY) {
      const batch = results.splice(0, results.length);
      await flushBatch(batch);
    }
  } catch (err) {
    fail++;
    const tags = [c.doLocal && c.localLang, c.doEn && 'en'].filter(Boolean).join(',');
    console.error(`  ✗ [${c.geo}] "${c.keyword}" (${tags}): ${err.message}`);
  }
});

if (results.length) {
  await flushBatch(results);
}

console.log(`Done. ok=${ok}, fail=${fail}, skipped=${candidates.length - list.length}`);

// ---------------------------------------------------------------------------

async function collectCandidates(geos, date, force, onlyLang) {
  const geoList = geos.map((g) => `'${g.code}'`).join(',');
  // 当天每个 (geo, keyword) 的峰值快照；LEFT JOIN keyword_intro 判断缺哪种语言
  const joinCond = 'LEFT JOIN keyword_intro i ON i.keyword = t.keyword AND i.geo = t.geo';
  // 指定 --date 时按该日期过滤；否则取每个 geo 的最新本地日期
  // （date 列现在是本地日期，单一 UTC 今天无法匹配所有时区）。
  const dateJoin = date
    ? ''
    : 'JOIN (SELECT geo AS g, MAX(date) AS d FROM trend_snapshots GROUP BY geo) m ON m.g = s.geo AND m.d = s.date';
  const dateWhere = date ? 'WHERE s.date = ?' : '';
  const params = date ? [date] : [];
  const rows = await queryAll(
    `SELECT t.keyword, t.geo, t.news_json, i.intro, i.intro_en, i.lang AS intro_lang
       FROM (
         SELECT s.date, s.geo, s.query AS keyword, s.news_json, s.search_volume,
                ROW_NUMBER() OVER (
                  PARTITION BY s.geo, s.date, s.query
                  ORDER BY s.search_volume DESC, s.observed_at DESC
                ) AS rn
           FROM trend_snapshots s
           ${dateJoin}
           ${dateWhere}
       ) t
       ${joinCond}
      WHERE t.rn = 1 AND t.geo IN (${geoList})
      ORDER BY t.geo ASC, t.search_volume DESC`,
    params,
  );
  const out = [];
  for (const r of rows) {
    const geoMeta = GEO_BY_CODE[r.geo];
    const c = makeCandidate(
      { keyword: r.keyword, geo: r.geo, news: safeJson(r.news_json, []), volume: r.search_volume || 0 },
      geoMeta,
      r.intro,
      r.intro_en,
      r.intro_lang,
      force,
    );
    // --only-lang 过滤：只补指定语言
    if (onlyLang === 'en') {
      c.doLocal = false;
    } else if (onlyLang === 'local') {
      c.doEn = false;
    }
    if (c.doLocal || c.doEn) out.push(c);
  }
  return out;
}

/**
 * --backfill-en 模式：直接扫描 keyword_intro，把所有「有当地 intro、缺英文」的行
 * 翻译补齐。不依赖 trend_snapshots 的日期范围，覆盖历史所有 keyword。
 */
async function collectBackfillEn(geos) {
  const geoList = geos.map((g) => `'${g.code}'`).join(',');
  // LEFT JOIN trend_snapshots 取每个 (keyword, geo) 的历史峰值 volume，用于 top-N 分层。
  // WHERE 包含 EN_GEOS_NEED_EN_INTRO（如 IN）——这些英语 geo 也需要回填 intro_en。
  const enNeedList = [...EN_GEOS_NEED_EN_INTRO].map((g) => `'${g}'`).join(',');
  const langClause = enNeedList
    ? `(i.lang != 'en' OR i.geo IN (${enNeedList}))`
    : `i.lang != 'en'`;
  const rows = await queryAll(
    `SELECT i.keyword, i.geo, i.lang, i.intro, COALESCE(v.vol, 0) AS vol
       FROM keyword_intro i
       LEFT JOIN (
         SELECT query AS keyword, geo, MAX(search_volume) AS vol
           FROM trend_snapshots GROUP BY query, geo
       ) v ON v.keyword = i.keyword AND v.geo = i.geo
      WHERE ${langClause} AND i.intro IS NOT NULL AND i.intro_en IS NULL
        AND i.geo IN (${geoList})
      ORDER BY i.geo ASC, vol DESC, i.keyword ASC`,
  );
  const out = [];
  for (const r of rows) {
    const geoMeta = GEO_BY_CODE[r.geo];
    const localLang = geoMeta?.lang ?? r.lang ?? 'en';
    out.push({
      keyword: r.keyword,
      geo: r.geo,
      news: [],
      volume: r.vol || 0,
      localLang,
      doLocal: false,
      doEn: true,
      existingLocalIntro: r.intro,
    });
  }
  return out;
}

/**
 * 给候选分配翻译分层。候选须已按 geo ASC、volume DESC 排序。
 * 每个 geo 内 volume 前 N 名（且需要翻译 doEn）→ 'azure'，其余 → 'google'。
 * azureTopN <= 0 时全部走 google（省 Azure 配额）。
 * 排名统计包含 doEn=false 的候选（它们占据 top-N 名额但不翻译），
 * 这样「top-N」真正反映该 geo 热度排名。
 */
function assignTiers(candidates, azureTopN) {
  if (azureTopN <= 0) {
    for (const c of candidates) if (c.doEn) c.tier = 'google';
    return;
  }
  let curGeo = null;
  let rank = 0;
  for (const c of candidates) {
    if (c.geo !== curGeo) { curGeo = c.geo; rank = 0; }
    rank++;
    if (!c.doEn) continue;
    // 英语 geo 特例（如 IN）始终走 Google 免费，不消耗 Azure 配额。
    if (EN_GEOS_NEED_EN_INTRO.has(c.geo)) { c.tier = 'google'; continue; }
    c.tier = rank <= azureTopN ? 'azure' : 'google';
  }
}

/**
 * 构造单个候选对象，计算还需生成/翻译哪些语言。
 * @param {{keyword:string,geo:string,news:any[]}} base
 * @param {{lang:string}|undefined} geoMeta
 * @param {string|null} intro      - 已缓存的当地语言 intro
 * @param {string|null} introEn    - 已缓存的英文 intro
 * @param {string|null} introLang  - 已缓存行记录的 lang
 * @param {boolean} force          - 强制重生成
 */
function makeCandidate(base, geoMeta, intro, introEn, introLang, force) {
  const localLang = geoMeta?.lang ?? 'en';
  // 非英语 geo，或 EN_GEOS_NEED_EN_INTRO 中的英语 geo（如 IN），都需要 intro_en。
  const needEn = localLang !== 'en' || EN_GEOS_NEED_EN_INTRO.has(base.geo);
  let doLocal = false;
  let doEn = false;
  if (force) {
    doLocal = true;
    doEn = needEn;
  } else if (introLang == null || intro == null) {
    // 没有缓存行或当地语言缺失：补齐当地语言（+ 英文翻译，如果 needEn）
    doLocal = true;
    doEn = needEn;
  } else if (needEn && introEn == null) {
    // 当地语言已有，只缺英文 → 翻译
    doEn = true;
  }
  return { ...base, localLang, doLocal, doEn, existingLocalIntro: intro };
}

function applyTopPerGeo(candidates, topN) {
  const byGeo = new Map();
  for (const c of candidates) {
    if (!byGeo.has(c.geo)) byGeo.set(c.geo, []);
    byGeo.get(c.geo).push(c);
  }
  const out = [];
  for (const list of byGeo.values()) out.push(...list.slice(0, topN));
  return out;
}

async function runOne(c) {
  const { localLang, doLocal, doEn, existingLocalIntro } = c;
  let localIntro = doLocal ? null : existingLocalIntro;
  let enIntro = null;
  let model = null;

  if (doLocal) {
    const { intro, model: m } = await generateIntro({
      keyword: c.keyword, geo: c.geo, lang: localLang, news: c.news,
    });
    model = m;
    localIntro = intro;
    const preview = intro.length > 80 ? intro.slice(0, 80) + '…' : intro;
    console.log(`  ✓ [${c.geo}] "${c.keyword}" (${localLang}) — ${preview}`);
  }

  if (doEn) {
    // 非英语 geo：把当地语言 intro 翻译成英文，而不是再次调用 AI 生成。
    // 分层：top-N 走 Azure（高质量），其余走 Google 免费 gtx 端点。
    // 两个 provider 都自动检测源语种，兼容混合语种 summary（如马来西亚英/马/中混排）。
    const source = localIntro || existingLocalIntro;
    if (!source) {
      console.warn(`  ⚠ [${c.geo}] "${c.keyword}" skip en: no local intro to translate`);
    } else {
      try {
        enIntro = await translate(source, { to: 'en', tier: c.tier });
        const preview = enIntro.length > 80 ? enIntro.slice(0, 80) + '…' : enIntro;
        console.log(`  ✓ [${c.geo}] "${c.keyword}" (en·${c.tier}) — ${preview}`);
        if (!model) model = c.tier === 'azure' ? 'azure-translate' : 'google-translate';
      } catch (err) {
        console.warn(`  ⚠ [${c.geo}] "${c.keyword}" translate failed (${c.tier}): ${err.message}`);
      }
    }
  }

  // 当地语言 = en 时：生成的英文就是当地语言版本，存进 intro。
  // 但 EN_GEOS_NEED_EN_INTRO（如 IN）例外——它们的 intro 可能是外语，
  // 需要单独存英文翻译到 intro_en，渲染时优先取 intro_en。
  let introOut = localIntro;
  let introEnOut = enIntro;
  if (localLang === 'en' && !EN_GEOS_NEED_EN_INTRO.has(c.geo)) {
    if (introOut == null) introOut = enIntro;
    introEnOut = null; // en geo 不单独存英文，渲染时回退到 intro
  }
  return { keyword: c.keyword, geo: c.geo, lang: localLang, intro: introOut, intro_en: introEnOut, model };
}

async function flushBatch(results) {
  if (!results.length) return;
  const nowSec = Math.floor(Date.now() / 1000);
  // COALESCE upsert：只覆盖本次生成/翻译过的字段（非 NULL），保留另一种语言。
  // intro/intro_en 均允许 NULL，故仅补英文时 intro 传 NULL 安全——既有行经
  // ON CONFLICT DO UPDATE 用 COALESCE 保留原 intro；新行则写入 NULL。
  // model 同样用 COALESCE：仅翻译失败（model=NULL）时不覆盖原 AI model。
  const stmts = results.map((r) => ({
    sql: `INSERT INTO keyword_intro (keyword, geo, lang, intro, intro_en, model, generated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(keyword, geo) DO UPDATE SET
            lang = COALESCE(excluded.lang, keyword_intro.lang),
            intro = COALESCE(excluded.intro, keyword_intro.intro),
            intro_en = COALESCE(excluded.intro_en, keyword_intro.intro_en),
            model = COALESCE(excluded.model, keyword_intro.model),
            generated_at = excluded.generated_at`,
    params: [r.keyword, r.geo, r.lang, r.intro, r.intro_en, r.model, nowSec],
  }));
  await executeBatch(stmts);
}

async function runPool(items, concurrency, fn) {
  let idx = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (idx < items.length) {
        const my = items[idx++];
        await fn(my);
      }
    }),
  );
}

function safeJson(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}
