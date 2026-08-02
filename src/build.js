// Static Site Generator (incremental).
//
// Output directory layout:
//   public/
//     index.html
//     geo/{CODE}/index.html            (= latest date, also saved as YYYY-MM-DD.html)
//     geo/{CODE}/{YYYY-MM-DD}.html
//     geo/{CODE}/archive.html
//     geo/{CODE}/keyword/{slug}.html   # dynamically rendered by Pages Functions
//
// New-schema query: each (geo, date, keyword) has multiple 4h snapshots per day.
// Use ROW_NUMBER() OVER (PARTITION BY geo,date,query ORDER BY search_volume DESC, observed_at DESC)
// to pick the peak-volume row of the day as the representative for that keyword.
//
// CLI:
//   node src/build.js                 # incremental
//   node src/build.js --full          # force rewrite everything
//   node src/build.js --clean         # delete geo/ and index.html, then rebuild
//   node src/build.js US JP           # build only the specified geos

import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { queryAll } from './db.js';
import { GEOS } from './geos.js';
import {
  homePage,
  geoPage,
  geoArchivePage,
  keywordPage,
  aboutPage,
  termsPage,
  feedbackPage,
  contactPage,
} from './templates.js';

const OUT = 'public';

// Pick the peak-volume snapshot per (geo, date, keyword) and LEFT JOIN keyword_intro.
// Convert started_at to unix seconds to match templates (old schema also used unix seconds).
// Fetch both intro (local language) and intro_en (English): geo static pages use intro,
// while the WW homepage aggregation uses intro_en (avoids multi-language SEO penalty on a single page).
const PEAK_SNAPSHOT_SQL = `
SELECT t.date, t.geo, t.keyword, t.search_volume_num, t.search_volume_raw,
       t.started_at, t.picture, t.news_json, t.trend_breakdown_json, t.explore_url,
       i.intro AS intro, i.intro_en AS intro_en
  FROM (
    SELECT s.date, s.geo, s.query AS keyword,
           s.search_volume AS search_volume_num,
           s.search_volume_label AS search_volume_raw,
           CAST(strftime('%s', s.started_at) AS INTEGER) AS started_at,
           s.picture, s.news_json, s.trend_breakdown_json, s.explore_url,
           ROW_NUMBER() OVER (
             PARTITION BY s.geo, s.date, s.query
             ORDER BY s.search_volume DESC, s.observed_at DESC
           ) AS rn
      FROM trend_snapshots s
  ) t
  LEFT JOIN keyword_intro i
    ON i.keyword = t.keyword AND i.geo = t.geo
 WHERE t.rn = 1
 ORDER BY t.geo, t.date DESC, t.search_volume_num DESC`;

// Raw snapshots from the last 48h (no per-day peak merging), used to aggregate
// the WW homepage into 4h collection buckets. Each bucket takes all geos'
// snapshots in that 4h window, deduped by keyword across geos (highest volume wins).
const RECENT_BUCKETS_SQL = `
SELECT s.observed_at, s.geo, s.query AS keyword,
       s.search_volume AS search_volume_num,
       s.search_volume_label AS search_volume_raw,
       CAST(strftime('%s', s.started_at) AS INTEGER) AS started_at,
       s.picture, s.news_json, s.explore_url,
       i.intro AS intro, i.intro_en AS intro_en
  FROM trend_snapshots s
  LEFT JOIN keyword_intro i
    ON i.keyword = s.query AND i.geo = s.geo
 WHERE s.observed_at >= ?
 ORDER BY s.observed_at DESC, s.search_volume DESC`;

// CLI ----------------------------------------------------------------------

const args = process.argv.slice(2);
const cleanFirst = args.includes('--clean');
const fullRebuild = args.includes('--full') || cleanFirst;
const onlyGeos = args.filter((a) => !a.startsWith('--'));
const targetGeoSet = onlyGeos.length ? new Set(onlyGeos) : null;
const daysArg = args.find((a) => a.startsWith('--days='));
const keepDays = daysArg ? parseInt(daysArg.split('=')[1], 10) : 0;

const t0 = Date.now();
console.log(
  `Building static site into ./${OUT}` +
    (fullRebuild ? ' [full]' : ' [incremental]') +
    (targetGeoSet ? ' (geos: ' + [...targetGeoSet].join(',') + ')' : ''),
);

if (cleanFirst) {
  await rm(join(OUT, 'geo'), { recursive: true, force: true });
  await rm(join(OUT, 'index.html'), { force: true });
}

let written = 0;
let skipped = 0;

// 1. Load all data ---------------------------------------------------------

const allRows = await queryAll(PEAK_SNAPSHOT_SQL, []);
console.log(`Loaded ${allRows.length} trend rows from D1.`);

/** @type {Map<string, Map<string, object[]>>} */
const byGeoDate = new Map();
for (const r of allRows) {
  if (!byGeoDate.has(r.geo)) byGeoDate.set(r.geo, new Map());
  const m = byGeoDate.get(r.geo);
  if (!m.has(r.date)) m.set(r.date, []);
  m.get(r.date).push(r);
}

// Re-rank sequentially (1..N) within each (geo, date) by search volume so the
// hottest topics come first.
for (const m of byGeoDate.values()) {
  for (const items of m.values()) {
    items.forEach((item, i) => { item.rank = i + 1; });
  }
}

const latestDate = new Map();
for (const [geo, m] of byGeoDate.entries()) {
  const dates = [...m.keys()].sort((a, b) => (a < b ? 1 : -1));
  latestDate.set(geo, dates[0]);
}

// Raw 48h snapshots: shared by the WW homepage and each geo latest page's 4h columns, queried once.
const recentCutoff = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
const recentRows = await queryAll(RECENT_BUCKETS_SQL, [recentCutoff]);
// Group by geo so each geo latest page can build its 4h columns.
const recentByGeo = new Map();
for (const r of recentRows) {
  if (!recentByGeo.has(r.geo)) recentByGeo.set(r.geo, []);
  recentByGeo.get(r.geo).push(r);
}
console.log(`Loaded ${recentRows.length} recent (48h) snapshot rows for hours-columns.`);

// 2. Home page — Worldwide, with per-bucket time-ago sections ---------------
// WW cannot be scraped directly. Aggregate by 4h collection bucket instead: each bucket
// takes all geos' snapshots in that 4h window, deduped by keyword across geos (highest
// volume wins), sorted by search volume desc. The homepage shows the "latest bucket" TOP N
// as the main list, then appends several earlier buckets (4h ago / 8h ago / ... / Yesterday)
// as time-ago sections, with the datebar linking to older date pages.
const wwHome = await buildWwHomepage(byGeoDate, recentRows);
await maybeWrite(
  join(OUT, 'index.html'),
  homePage({
    items: wwHome.latestItems,
    geoCode: 'WW',
    availableDates: wwHome.wwDates,
    latestTimeIso: wwHome.latestTimeIso,
    sections: wwHome.agoSections,
  }),
);
console.log(
  `  WW: ${wwHome.latestItems.length} latest + ${wwHome.agoSections.length} time-ago sections, ${wwHome.wwDates.length} historical dates`,
);

// 2b. Static content pages
await maybeWrite(join(OUT, 'about.html'), aboutPage());
await maybeWrite(join(OUT, 'terms.html'), termsPage());
await maybeWrite(join(OUT, 'feedback.html'), feedbackPage());
await maybeWrite(join(OUT, 'contact.html'), contactPage());

// 3. Per-geo pages ---------------------------------------------------------

for (const g of GEOS) {
  if (targetGeoSet && !targetGeoSet.has(g.code)) continue;
  const m = byGeoDate.get(g.code);
  if (!m) continue;

  let dates = [...m.keys()].sort((a, b) => (a < b ? 1 : -1));
  if (keepDays > 0) {
    dates = dates.slice(0, keepDays);
  }
  const latest = dates[0];

  const beforeWritten = written;
  const beforeSkipped = skipped;

  for (let i = 0; i < dates.length; i += 1) {
    const date = dates[i];
    const trends = m.get(date);
    const isLatest = i === 0;
    let html;
    if (isLatest) {
      // Latest geo page: 4h columns (latest + 6 time-ago), sourced from the last 48h snapshots.
      // Falls back to the single per-day peak column when no 48h data is available.
      const gb = buildGeoBucketsFromRows(recentByGeo.get(g.code) || [], g.lang);
      const hasRecent = gb.latestItems.length > 0;
      html = geoPage({
        geoMeta: g, date, isLatest: true,
        trends: hasRecent ? gb.latestItems : trends,
        availableDates: dates,
        sections: hasRecent ? gb.agoSections : [],
        latestTimeIso: hasRecent ? gb.latestTimeIso : undefined,
        lang: g.lang,
      });
    } else {
      html = geoPage({ geoMeta: g, date, isLatest: false, trends, availableDates: dates });
    }

    if (isLatest) {
      await maybeWrite(join(OUT, 'geo', g.code, 'index.html'), html);
      await maybeWrite(join(OUT, 'geo', g.code, `${date}.html`), html);
    } else {
      await maybeWrite(join(OUT, 'geo', g.code, `${date}.html`), html);
    }
  }

  if (dates.length > 7) {
    await maybeWrite(
      join(OUT, 'geo', g.code, 'archive.html'),
      geoArchivePage({ geoMeta: g, dates }),
    );
  }

  const w = written - beforeWritten;
  const s = skipped - beforeSkipped;
  console.log(`  ${g.code}: ${dates.length} dates · wrote ${w}, skipped ${s}`);
}

const dt = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`Done in ${dt}s. Wrote ${written}, skipped ${skipped} (total ${written + skipped} pages).`);

// ---------------------------------------------------------------------------

async function maybeWrite(path, content) {
  if (!fullRebuild) {
    const existing = await safeReadHash(path);
    if (existing && existing === sha1(content)) {
      skipped++;
      return;
    }
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
  written++;
}

async function safeReadHash(path) {
  try {
    const buf = await readFile(path);
    return sha1(buf);
  } catch {
    return null;
  }
}

function sha1(input) {
  return createHash('sha1').update(input).digest('hex');
}

// Aggregate the WW homepage into 4h UTC buckets. Returns:
//   latestItems  — TOP N of the latest bucket (homepage main list)
//   latestTime   — max observed_at in the latest bucket, minute-precision, e.g. "2026-08-01 18:35"
//   latestTimeIso— same value as ISO (for client-side timezone rewriting)
//   latestDate   — local date of the latest bucket (YYYY-MM-DD, for datebar highlight)
//   agoSections  — a few earlier buckets, each TOP M, labeled "4 hours ago" … "Yesterday"
//   wwDates      — union of all geo dates (for datebar links to older dates)
async function buildWwHomepage(byGeoDate, recentRows) {
  const rows = recentRows;

  // Group into 4h buckets (aligned to cron 0/4/8/12/16/20 UTC)
  const byBucket = new Map();
  for (const r of rows) {
    const key = bucketKey(r.observed_at);
    if (!byBucket.has(key)) byBucket.set(key, []);
    byBucket.get(key).push(r);
  }
  const bucketKeys = [...byBucket.keys()].sort((a, b) => (a < b ? 1 : -1));

  // Aggregate WW per bucket (dedupe by keyword across geos, keep highest volume)
  const perBucket = bucketKeys.map((k) => {
    const raw = byBucket.get(k);
    const latestObs = raw.map((r) => r.observed_at).sort().pop();
    return { bucketKey: k, latestObs, items: aggregateWwBucket(raw, 100) };
  });

  const latest = perBucket[0];
  const latestItems = latest
    ? latest.items.slice(0, 100).map((it, i) => ({ ...it, rank: i + 1 }))
    : [];
  const latestTimeIso = latest?.latestObs ?? new Date().toISOString();

  // Latest 6 earlier buckets → time-ago sections (4h/8h/12h/16h/20h/24h ago; 24h labeled "Yesterday")
  const agoSections = [];
  for (let off = 1; off <= 6; off += 1) {
    const b = perBucket[off];
    if (!b) break;
    const hours = off * 4;
    const label = hours >= 24 ? 'Yesterday' : `${hours} hours ago`;
    const items = b.items.slice(0, 100).map((it, i) => ({ ...it, rank: i + 1 }));
    // latestObs = newest observed_at in the bucket (ISO), used by the client to compute "X hours ago"
    agoSections.push({ label, items, obsIso: b.latestObs });
  }

  const wwDates = [...new Set(
    [...byGeoDate.values()].flatMap((m) => [...m.keys()])
  )].sort((a, b) => (a < b ? 1 : -1));

  return { latestItems, latestTimeIso, agoSections, wwDates };
}

// Aggregate WW within a single 4h bucket across geos: dedupe by normalized keyword (keep
// highest volume), sort by search volume desc, take TOP N. Use the English summary
// (intro_en, falling back to intro).
function aggregateWwBucket(rows, topN) {
  const byKey = new Map();
  for (const it of rows) {
    if (it.geo === 'WW') continue;
    const key = (it.keyword || '').toString().toLowerCase().trim();
    if (!key) continue;
    const prev = byKey.get(key);
    if (!prev || (it.search_volume_num ?? 0) > (prev.search_volume_num ?? 0)) {
      byKey.set(key, it);
    }
  }
  return [...byKey.values()]
    .sort((a, b) => (b.search_volume_num ?? 0) - (a.search_volume_num ?? 0))
    .slice(0, topN)
    .map((it) => ({ ...it, intro: it.intro_en || it.intro || null }));
}

// 4h columns for a single geo: latest + 6 time-ago buckets.
// Unlike WW: no cross-geo aggregation; each bucket is just that geo's snapshots in the 4h
// window (deduped by keyword, highest volume kept).
// Pick intro by render language (en → intro_en falling back to intro; otherwise intro).
function buildGeoBucketsFromRows(rows, lang) {
  const byBucket = new Map();
  for (const r of rows) {
    const key = bucketKey(r.observed_at);
    if (!byBucket.has(key)) byBucket.set(key, []);
    byBucket.get(key).push(r);
  }
  const bucketKeys = [...byBucket.keys()].sort((a, b) => (a < b ? 1 : -1));
  const perBucket = bucketKeys.map((k) => {
    const raw = byBucket.get(k);
    const latestObs = raw.map((r) => r.observed_at).sort().pop();
    const items = dedupGeoBucket(raw).map((it) => ({ ...it, intro: pickIntro(it, lang) }));
    return { latestObs, items };
  });
  const latest = perBucket[0];
  const latestItems = latest ? latest.items.map((it, i) => ({ ...it, rank: i + 1 })) : [];
  const latestTimeIso = latest?.latestObs ?? new Date().toISOString();
  const agoSections = [];
  for (let off = 1; off <= 6; off += 1) {
    const b = perBucket[off];
    if (!b) break;
    const hours = off * 4;
    const label = hours >= 24 ? 'Yesterday' : `${hours} hours ago`;
    const items = b.items.map((it, i) => ({ ...it, rank: i + 1 }));
    agoSections.push({ label, items, obsIso: b.latestObs });
  }
  return { latestItems, latestTimeIso, agoSections };
}

// Within a single 4h bucket, dedupe by normalized keyword (keep highest volume), sort by search volume desc.
function dedupGeoBucket(rows) {
  const byKey = new Map();
  for (const it of rows) {
    const key = (it.keyword || '').toString().toLowerCase().trim();
    if (!key) continue;
    const prev = byKey.get(key);
    if (!prev || (it.search_volume_num ?? 0) > (prev.search_volume_num ?? 0)) {
      byKey.set(key, it);
    }
  }
  return [...byKey.values()].sort((a, b) => (b.search_volume_num ?? 0) - (a.search_volume_num ?? 0));
}

function pickIntro(it, lang) {
  if (lang === 'en') return it.intro_en || it.intro || null;
  return it.intro || null;
}

// Map observed_at (ISO) to a 4h-aligned bucket key "YYYY-MM-DD HH:00" (UTC).
// Cron runs at 0/4/8/12/16/20 UTC; each geo's observed_at falls inside its 4h window.
function bucketKey(observedAtIso) {
  const d = new Date(observedAtIso);
  const h = d.getUTCHours();
  const bh = h - (h % 4);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(bh).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:00`;
}
