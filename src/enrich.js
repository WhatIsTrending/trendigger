// Enrich: generate intros (in the local language) for keywords missing them, and
// translate non-English intros into English.
// Usage:
//   node src/enrich.js                       # today, all geos
//   node src/enrich.js US JP                 # specific geos only
//   node src/enrich.js --date 2026-04-25 US
//   node src/enrich.js --keyword "anthony edwards" --geo US   # force-regenerate a single item
//   node src/enrich.js --limit 20            # cap items this run (saves quota)
//   node src/enrich.js --top 50              # only top 50 by volume per geo (default 50, 0 = unlimited)
//   node src/enrich.js --only-lang en        # only fill English (translate existing local intro)
//   node src/enrich.js --only-lang local     # only fill the local-language version
//   node src/enrich.js --backfill-en         # scan all historical rows missing intro_en and translate them
//   node src/enrich.js --azure-top 10        # top 10 per non-English geo via Azure, rest via Google (default 10)
//
// Logic:
//   1) Take the peak snapshot (including news_json) for each (geo, keyword) today from trend_snapshots.
//   2) LEFT JOIN keyword_intro to decide which language is still missing:
//        - Local language (geoMeta.lang) missing        → generate local-language intro
//        - Local language non-en and English missing    → translate local intro to English (tiered routing)
//        - Local language = en: generate once, store in intro, leave intro_en NULL (renderer falls back)
//   3) Translation tiering (assignTiers): within each non-English geo, sort by volume —
//        top-N (--azure-top, default 10) → Azure Translator (high quality, free tier 2M chars/month)
//        the rest                        → Google free gtx endpoint (same source as googletrans)
//      English geos (lang='en') are not translated.
//   4) COALESCE upsert: only overwrite fields actually generated/translated this run;
//      don't clobber the other language already stored.
//   5) Failures don't abort the whole run; they are logged.

import { queryAll, executeBatch } from './db.js';
import { generateIntro } from './providers.js';
import { translate } from './translate.js';
import { GEOS, GEO_BY_CODE } from './geos.js';

// Special English geos whose intro still needs translating into intro_en.
// Reason: the snippet provider doesn't guarantee English (it often returns the news source
// language, e.g. Spanish for "real madrid"), leaving intro_en empty for these en geos and
// showing foreign text on the page. IN is included for now; other en geos are untouched.
// These geos always use Google free translation and don't consume Azure quota.
const EN_GEOS_NEED_EN_INTRO = new Set(['IN']);

async function main() {
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

// --keyword mode: generate a single item, ignoring date.
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

// Batch mode.
const candidates = flags.backfillEn
  ? await collectBackfillEn(targetGeos)
  : await collectCandidates(targetGeos, flags.date, flags.force, flags.onlyLang);
// Assign a translation tier to each doEn candidate: within each geo, sort by volume
// descending — top-N → azure, the rest → google.
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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// ---------------------------------------------------------------------------

async function collectCandidates(geos, date, force, onlyLang) {
  const geoList = geos.map((g) => `'${g.code}'`).join(',');
  // Peak snapshot for each (geo, keyword) today; LEFT JOIN keyword_intro to see which language is missing.
  const joinCond = 'LEFT JOIN keyword_intro i ON i.keyword = t.keyword AND i.geo = t.geo';
  // When --date is given, filter by that date; otherwise take each geo's latest local date
  // (the date column is now a local date, so a single UTC "today" can't match all time zones).
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
    // --only-lang filter: only fill the specified language.
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
 * --backfill-en mode: scan keyword_intro directly and translate every row that has a
 * local intro but is missing English. Doesn't depend on trend_snapshots date ranges
 * and covers all historical keywords.
 */
async function collectBackfillEn(geos) {
  const geoList = geos.map((g) => `'${g.code}'`).join(',');
  // LEFT JOIN trend_snapshots to get each (keyword, geo) historical peak volume for top-N tiering.
  // WHERE includes EN_GEOS_NEED_EN_INTRO (e.g. IN) — these English geos also need intro_en backfill.
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
 * Assign a translation tier to each candidate. Candidates must already be sorted by
 * geo ASC, volume DESC. Within each geo, the top-N by volume (that need translation, doEn)
 * → 'azure', the rest → 'google'. When azureTopN <= 0 everything goes to google
 * (saves Azure quota). Candidates with doEn=false still count toward the ranking
 * (they occupy top-N slots but aren't translated), so "top-N" reflects the geo's true
 * hotness ranking.
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
    // English-geo exceptions (e.g. IN) always use Google free; don't consume Azure quota.
    if (EN_GEOS_NEED_EN_INTRO.has(c.geo)) { c.tier = 'google'; continue; }
    c.tier = rank <= azureTopN ? 'azure' : 'google';
  }
}

/**
 * Build a single candidate object, computing which languages still need to be
 * generated/translated.
 * @param {{keyword:string,geo:string,news:any[]}} base
 * @param {{lang:string}|undefined} geoMeta
 * @param {string|null} intro      - cached local-language intro
 * @param {string|null} introEn    - cached English intro
 * @param {string|null} introLang  - lang recorded on the cached row
 * @param {boolean} force          - force regeneration
 */
function makeCandidate(base, geoMeta, intro, introEn, introLang, force) {
  const localLang = geoMeta?.lang ?? 'en';
  // Non-English geos, or English geos in EN_GEOS_NEED_EN_INTRO (e.g. IN), need intro_en.
  const needEn = localLang !== 'en' || EN_GEOS_NEED_EN_INTRO.has(base.geo);
  // Skip AI generation when there's no news: with no news leads the model easily hallucinates
  // unrelated content (e.g. misreading geo=DE as Delaware). Translating an existing local
  // intro to English is unaffected.
  const hasNews = Array.isArray(base.news) && base.news.length > 0;
  let doLocal = false;
  let doEn = false;
  if (force && hasNews) {
    doLocal = true;
    doEn = needEn;
  } else if ((introLang == null || intro == null) && hasNews) {
    // No cached row or local language missing: fill the local language (+ English translation if needEn).
    doLocal = true;
    doEn = needEn;
  } else if (needEn && introEn == null) {
    // Local language already present, only English missing → translate.
    doEn = true;
  }
  return { ...base, localLang, geoName: geoMeta?.name ?? base.geo, doLocal, doEn, existingLocalIntro: intro };
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
      keyword: c.keyword, geo: c.geo, geoName: c.geoName, lang: localLang, news: c.news,
    });
    model = m;
    localIntro = intro;
    const preview = intro.length > 80 ? intro.slice(0, 80) + '…' : intro;
    console.log(`  ✓ [${c.geo}] "${c.keyword}" (${localLang}) — ${preview}`);
  }

  if (doEn) {
    // Non-English geo: translate the local-language intro to English rather than calling the
    // AI again. Tiering: top-N via Azure (high quality), the rest via the Google free gtx
    // endpoint. Both providers auto-detect the source language, supporting mixed-language
    // summaries (e.g. Malaysia mixing English / Malay / Chinese).
    const source = localIntro || existingLocalIntro;
    if (!source) {
      console.warn(`  ⚠ [${c.geo}] "${c.keyword}" skip en: no local intro to translate`);
    } else {
      try {
        // Pass from=localLang as a fallback for when auto-detect misfires (except for en geos:
        // IN and similar en-geo intros may be in a foreign language, so auto-detect is needed
        // to identify the real source language).
        const from = localLang !== 'en' ? localLang : undefined;
        enIntro = await translate(source, { to: 'en', from, tier: c.tier });
        const preview = enIntro.length > 80 ? enIntro.slice(0, 80) + '…' : enIntro;
        console.log(`  ✓ [${c.geo}] "${c.keyword}" (en·${c.tier}) — ${preview}`);
        if (!model) model = c.tier === 'azure' ? 'azure-translate' : 'google-translate';
      } catch (err) {
        console.warn(`  ⚠ [${c.geo}] "${c.keyword}" translate failed (${c.tier}): ${err.message}`);
      }
    }
  }

  // When the local language is en: the generated English is the local-language version,
  // stored in intro. EN_GEOS_NEED_EN_INTRO (e.g. IN) is an exception — their intro may be
  // in a foreign language, so the English translation goes into intro_en separately and the
  // renderer prefers intro_en.
  let introOut = localIntro;
  let introEnOut = enIntro;
  if (localLang === 'en' && !EN_GEOS_NEED_EN_INTRO.has(c.geo)) {
    if (introOut == null) introOut = enIntro;
    introEnOut = null; // en geo: don't store English separately; renderer falls back to intro.
  }
  return { keyword: c.keyword, geo: c.geo, lang: localLang, intro: introOut, intro_en: introEnOut, model };
}

async function flushBatch(results) {
  if (!results.length) return;
  const nowSec = Math.floor(Date.now() / 1000);
  // COALESCE upsert: only overwrite fields actually generated/translated this run (non-NULL),
  // preserving the other language. intro/intro_en both allow NULL, so passing NULL for intro
  // when only filling English is safe — existing rows keep their intro via
  // ON CONFLICT DO UPDATE COALESCE, new rows get NULL. model uses COALESCE too, so a failed
  // translation (model=NULL) doesn't overwrite the original AI model.
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
