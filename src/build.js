// Static Site Generator (incremental).
//
// 输出目录结构：
//   public/
//     index.html
//     geo/{CODE}/index.html            (= 最新日期，同时另存 YYYY-MM-DD.html)
//     geo/{CODE}/{YYYY-MM-DD}.html
//     geo/{CODE}/archive.html
//     geo/{CODE}/keyword/{slug}.html   # 由 Pages Functions 动态渲染
//
// 新 schema 下的查询：每个 (geo, date, keyword) 在一天内会有多个 4h 快照，
// 用 ROW_NUMBER() OVER (PARTITION BY geo,date,query ORDER BY search_volume DESC, observed_at DESC)
// 取当天 volume 峰值那条作为该关键词当天的代表行。
//
// CLI:
//   node src/build.js                 # 增量
//   node src/build.js --full          # 强制重写所有
//   node src/build.js --clean         # 删 geo/ 与 index.html 后重建
//   node src/build.js US JP           # 只构建指定 geo

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

// 取每个 (geo, date, keyword) 当天 volume 峰值快照，并 LEFT JOIN keyword_intro。
// started_at 转成 unix 秒以兼容 templates（旧 schema 也是 unix 秒）。
// 同时取 intro（当地语言）和 intro_en（英文）：geo 静态页用 intro，
// WW 首页聚合时用 intro_en（避免单页多语言 SEO 降权）。
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

// 近 48h 的原始快照（不做当日峰值合并），用于 WW 首页按 4h 采集桶聚合。
// 每个桶取所有 geo 该 4h 窗口内的快照，跨 geo 按 keyword 去重（取 volume 最高）。
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

// 近 48h 原始快照：WW 首页 + 各 geo latest 页的 4h 横排都用它，只查一次。
const recentCutoff = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
const recentRows = await queryAll(RECENT_BUCKETS_SQL, [recentCutoff]);
// 按 geo 分组，供各 geo latest 页构建 4h 横排桶
const recentByGeo = new Map();
for (const r of recentRows) {
  if (!recentByGeo.has(r.geo)) recentByGeo.set(r.geo, []);
  recentByGeo.get(r.geo).push(r);
}
console.log(`Loaded ${recentRows.length} recent (48h) snapshot rows for hours-columns.`);

// 2. Home page — Worldwide, with per-bucket time-ago sections ---------------
// WW 无法直接抓取。改为按 4h 采集桶聚合：每个桶取所有 geo 该 4h 窗口内的快照，
// 跨 geo 按 keyword 去重（取 volume 最高），按搜索量降序。
// 首页展示「最新桶」TOP N 作为主列表，其后叠加最近若干桶（4h ago / 8h ago /
// ... / Yesterday）作为 time-ago 区块，再用 datebar 链接到更早的日期页。
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
      // latest geo 页：4h 横排（latest + 6 time-ago），数据来自近 48h 快照；
      // 无近 48h 数据时回退到当日峰值单列。
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

// 按 4h UTC 桶聚合 WW 首页。返回：
//   latestItems  — 最新桶 TOP N（首页主列表）
//   latestTime   — 最新桶内最大 observed_at，精确到分，如 "2026-08-01 18:35"
//   latestTimeIso— 同上的 ISO 形式（供前端按访问者时区重写）
//   latestDate   — 最新桶的本地日期（YYYY-MM-DD，供 datebar 高亮）
//   agoSections  — 最近若干更早桶，每桶 TOP M，label 为 "4 hours ago" … "Yesterday"
//   wwDates      — 所有 geo 日期并集（供 datebar 跳转更早日期）
async function buildWwHomepage(byGeoDate, recentRows) {
  const rows = recentRows;

  // 按 4h 桶分组（对齐 cron 0/4/8/12/16/20 UTC）
  const byBucket = new Map();
  for (const r of rows) {
    const key = bucketKey(r.observed_at);
    if (!byBucket.has(key)) byBucket.set(key, []);
    byBucket.get(key).push(r);
  }
  const bucketKeys = [...byBucket.keys()].sort((a, b) => (a < b ? 1 : -1));

  // 每个桶聚合 WW（跨 geo 按 keyword 去重，取 volume 最高）
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

  // 最近 6 个更早桶 → time-ago 区块（4h/8h/12h/16h/20h/24h ago，24h 标 Yesterday）
  const agoSections = [];
  for (let off = 1; off <= 6; off += 1) {
    const b = perBucket[off];
    if (!b) break;
    const hours = off * 4;
    const label = hours >= 24 ? 'Yesterday' : `${hours} hours ago`;
    const items = b.items.slice(0, 100).map((it, i) => ({ ...it, rank: i + 1 }));
    // latestObs = 该桶内最新 observed_at（ISO），供前端按访问时间计算 "X hours ago"
    agoSections.push({ label, items, obsIso: b.latestObs });
  }

  const wwDates = [...new Set(
    [...byGeoDate.values()].flatMap((m) => [...m.keys()])
  )].sort((a, b) => (a < b ? 1 : -1));

  return { latestItems, latestTimeIso, agoSections, wwDates };
}

// 单个 4h 桶内跨 geo 聚合 WW：按 normalized keyword 去重（取 volume 最高），
// 按搜索量降序取 TOP N。统一英文 summary（intro_en，回退 intro）。
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

// 单个 geo 的 4h 横排：latest + 6 time-ago 桶。
// 与 WW 不同：不跨 geo 聚合，每桶就是该 geo 该 4h 窗口的快照（按 keyword 去重取最高 volume）。
// intro 按渲染语言挑选（en → intro_en 回退 intro；否则 intro）。
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

// 单个 4h 桶内按 normalized keyword 去重（取 volume 最高），按搜索量降序。
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

// observed_at(ISO) → 4h 对齐的桶键 "YYYY-MM-DD HH:00"（UTC）。
// cron 在 0/4/8/12/16/20 UTC 触发，各 geo 的 observed_at 落在对应 4h 窗口内。
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
