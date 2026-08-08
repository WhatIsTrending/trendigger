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

// Raw snapshots from the last 24h (no per-day peak merging), used to aggregate
// the WW homepage and each geo latest page into a single "last 24 hours" view.
// Within the window we keep the peak search volume per keyword (multiple 4h
// collection points collapse into one daily value).
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

// Raw 24h snapshots: shared by the WW homepage and each geo latest page's daily
// aggregation, queried once.
const recentCutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
const recentRows = await queryAll(RECENT_BUCKETS_SQL, [recentCutoff]);
// Group by geo so each geo latest page can build its 4h columns.
const recentByGeo = new Map();
for (const r of recentRows) {
  if (!recentByGeo.has(r.geo)) recentByGeo.set(r.geo, []);
  recentByGeo.get(r.geo).push(r);
}
console.log(`Loaded ${recentRows.length} recent (48h) snapshot rows for hours-columns.`);

// 2. Home page — Worldwide, aggregated to a single "last 24 hours" view ------
// WW cannot be scraped directly. Aggregate the last 24h of snapshots across all geos
// into 4-hour time buckets (dedupe by keyword, peak volume wins per bucket).
const wwHome = await buildWwHomepage(byGeoDate, recentRows);
const wwBuckets = buildBuckets(recentRows, 'en');
await maybeWrite(
  join(OUT, 'index.html'),
  homePage({
    geoCode: 'WW',
    buckets: wwBuckets,
    availableDates: wwHome.wwDates,
  }),
);
console.log(
  `  WW: ${wwBuckets.reduce((n, b) => n + b.items.length, 0)} latest topics across ${wwBuckets.length} buckets, ${wwHome.wwDates.length} historical dates`,
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
    // Historical date pages only show the unified top 100 keywords.
    const trends = m.get(date).slice(0, 100);
    const isLatest = i === 0;
    let html;

    if (g.code === 'WW') {
      // Worldwide latest lives on the homepage (/). /geo/WW/ and /geo/WW/index.html
      // are redirected to / by the Pages Functions (geo/[geo]/index.js).
      // Only generate the historical date pages here.
      if (!isLatest) {
        html = geoPage({ geoMeta: g, date, isLatest: false, trends, availableDates: dates });
        await maybeWrite(join(OUT, 'geo', 'WW', `${date}.html`), html);
      }
      continue;
    }

    if (isLatest) {
      // Latest geo page: build 4-hour time buckets from the last 24h snapshots.
      // Falls back to the per-day peak column when no 24h snapshot data exists.
      const buckets = buildBuckets(recentByGeo.get(g.code) || [], g.lang);
      const latestTrends = buckets.length > 0 ? buckets.flatMap((b) => b.items) : trends;
      html = geoPage({
        geoMeta: g, date, isLatest: true,
        buckets,
        trends: latestTrends,
        availableDates: dates,
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

// Aggregate the WW homepage into a single "last 24 hours" view. Returns:
//   latestItems  — peak-volume keywords across all geos over the last 24h, ranked
//   wwDates      — union of all geo dates (for the date picker links to older dates)
async function buildWwHomepage(byGeoDate, recentRows) {
  const latestItems = aggregateDayWw(recentRows).map((it, i) => ({ ...it, rank: i + 1 }));
  const wwDates = [...new Set(
    [...byGeoDate.values()].flatMap((m) => [...m.keys()])
  )].sort((a, b) => (a < b ? 1 : -1));
  return { latestItems, wwDates };
}

// Aggregate WW over a 24h window across geos: dedupe by normalized keyword (keep
// the highest volume seen in the window) and sort by search volume desc.
// Use the English summary (intro_en, falling back to intro) for the single WW page.
function aggregateDayWw(rows) {
  const byKey = new Map();
  for (const it of rows) {
    if (it.geo === 'WW') continue;
    const key = normKeyword(it.keyword);
    if (!key) continue;
    const prev = byKey.get(key);
    if (!prev || vol(it) > vol(prev)) byKey.set(key, it);
  }
  return [...byKey.values()]
    .sort((a, b) => vol(b) - vol(a))
    .slice(0, 100)
    .map((it) => ({ ...it, intro: it.intro_en || it.intro || null }));
}

// Aggregate a single geo's last 24h into one day: dedupe by normalized keyword
// (keep the peak volume across the 4h collection points), sort by volume desc.
// Pick intro by render language (en → intro_en falling back to intro; otherwise intro).
function aggregateDayGeo(rows, lang) {
  const byKey = new Map();
  for (const it of rows) {
    const key = normKeyword(it.keyword);
    if (!key) continue;
    const prev = byKey.get(key);
    if (!prev || vol(it) > vol(prev)) byKey.set(key, it);
  }
  return [...byKey.values()]
    .sort((a, b) => vol(b) - vol(a))
    .slice(0, 100)
    .map((it) => ({ ...it, intro: pickIntro(it, lang) }));
}

// Build 4-hour time buckets from raw 24h snapshots for the "latest" page.
// Each bucket keeps the peak-volume row per keyword, ranked by search volume.
// Returns buckets newest-first, e.g.
//   [{ label: '1 hour ago', items: [...] }, { label: '5 hours ago', items: [...] }, ...]
// covering the last 24 hours (≈6 buckets). Used for the dual-column layout.
function buildBuckets(rows, lang) {
  const BUCKET_MS = 4 * 3600 * 1000;
  const now = Date.now();
  const byBucket = new Map();
  for (const it of rows) {
    const ts = it.observed_at ? Date.parse(it.observed_at) : 0;
    if (!ts) continue;
    const key = Math.floor(ts / BUCKET_MS);
    if (!byBucket.has(key)) byBucket.set(key, new Map());
    const m = byBucket.get(key);
    const nk = normKeyword(it.keyword);
    if (!nk) continue;
    const prev = m.get(nk);
    if (!prev || vol(it) > vol(prev)) m.set(nk, it);
  }
  const keys = [...byBucket.keys()].sort((a, b) => b - a); // newest bucket first
  const lastBucketKey = keys.length ? Math.floor(now / BUCKET_MS) : 0;
  return keys.map((bk) => {
    const items = [...byBucket.get(bk).values()]
      .sort((a, b) => vol(b) - vol(a))
      .slice(0, 100)
      .map((it, i) => ({ ...it, rank: i + 1, intro: pickIntro(it, lang) }));
    // Label = relative hours ago, aligned to 4h collection cadence (1, 5, 9, 13, ...).
    const idx = Math.max(0, lastBucketKey - bk);
    const hoursAgo = idx * 4 + 1;
    return { label: `${hoursAgo} hour${hoursAgo === 1 ? '' : 's'} ago`, items };
  });
}

function normKeyword(k) {
  return (k || '').toString().toLowerCase().trim();
}

function vol(it) {
  return it.search_volume_num ?? 0;
}

function pickIntro(it, lang) {
  if (lang === 'en') return it.intro_en || it.intro || null;
  return it.intro || null;
}
