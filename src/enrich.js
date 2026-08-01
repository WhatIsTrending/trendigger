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
//
// 逻辑：
//   1) 从 trend_snapshots 取当天每个 (geo, keyword) 的峰值快照（含 news_json）
//   2) LEFT JOIN keyword_intro：判断还缺哪种语言
//        - 当地语言（geoMeta.lang）缺失 → 生成当地语言
//        - 当地语言非 en 且英文缺失     → 把当地 intro 翻译成英文（Azure Translator）
//        - 当地语言 = en 时只生成一份，存 intro，intro_en 留空（渲染时回退）
//   3) COALESCE upsert：只更新本次生成/翻译过的字段，不覆盖已有的另一种语言
//   4) 失败不阻断整轮，记录到日志

import { queryAll, executeBatch } from './db.js';
import { generateIntro } from './providers.js';
import { translate } from './translate.js';
import { GEOS, GEO_BY_CODE } from './geos.js';

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
const candidates = await collectCandidates(targetGeos, flags.date, flags.force, flags.onlyLang);
const topped = flags.top > 0 ? applyTopPerGeo(candidates, flags.top) : candidates;
const list = flags.limit ? topped.slice(0, flags.limit) : topped;

console.log(
  `Enrich: ${flags.date ? 'date=' + flags.date : 'latest per geo'}, geos=${targetGeos.map((g) => g.code).join(',')}` +
    `, candidates=${candidates.length}` +
    (flags.top > 0 ? `, top=${flags.top}/geo (${topped.length} after top)` : '') +
    `, will process=${list.length}` +
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
      { keyword: r.keyword, geo: r.geo, news: safeJson(r.news_json, []) },
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
  let doLocal = false;
  let doEn = false;
  if (force) {
    doLocal = true;
    doEn = localLang !== 'en';
  } else if (introLang == null || intro == null) {
    // 没有缓存行或当地语言缺失：补齐当地语言（+ 英文翻译，如果非 en）
    doLocal = true;
    doEn = localLang !== 'en';
  } else if (localLang !== 'en' && introEn == null) {
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
    // Azure 自动检测源语种，兼容混合语种 summary（如马来西亚英/马/中混排）。
    const source = localIntro || existingLocalIntro;
    if (!source) {
      console.warn(`  ⚠ [${c.geo}] "${c.keyword}" skip en: no local intro to translate`);
    } else {
      try {
        enIntro = await translate(source, { to: 'en' });
        const preview = enIntro.length > 80 ? enIntro.slice(0, 80) + '…' : enIntro;
        console.log(`  ✓ [${c.geo}] "${c.keyword}" (en·translate) — ${preview}`);
        if (!model) model = 'azure-translate';
      } catch (err) {
        console.warn(`  ⚠ [${c.geo}] "${c.keyword}" translate failed: ${err.message}`);
      }
    }
  }

  // 当地语言 = en 时：生成的英文就是当地语言版本，存进 intro
  let introOut = localIntro;
  let introEnOut = enIntro;
  if (localLang === 'en') {
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
