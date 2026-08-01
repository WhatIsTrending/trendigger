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

// 2. Home page — aggregated global TOP 100 --------------------------------
// WW 无法直接抓取（google-trends-now 对 geo='' 返回 0 条）。改为聚合所有可抓取
// geo 各自「最新日期」的峰值快照：同一关键词跨 geo 出现时取 volume 最高那条，
// 按搜索量降序取 TOP 100，作为全球热搜静态首页。每次 build 重新生成，运行时
// 直接发静态 HTML，不再在线查 D1。
const globalItems = aggregateGlobal(byGeoDate, latestDate, 100);
const globalDate = globalItems.length
  ? globalItems[0].date
  : new Date().toISOString().slice(0, 10);
// WW 历史日期 = 所有 geo 日期的并集（供首页 datebar 跳转 /geo/WW/{date}.html）
const wwDates = [...new Set(
  [...byGeoDate.values()].flatMap((m) => [...m.keys()])
)].sort((a, b) => (a < b ? 1 : -1));
await maybeWrite(
  join(OUT, 'index.html'),
  homePage({ date: globalDate, items: globalItems, geoCode: 'WW', availableDates: wwDates }),
);
console.log(`  WW: aggregated ${globalItems.length} global trends (top 100), ${wwDates.length} historical dates`);

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
    const html = geoPage({ geoMeta: g, date, isLatest, trends, availableDates: dates });

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

// 聚合所有可抓取 geo（排除 WW）各自「最新日期」的峰值快照，按 normalized keyword
// 跨 geo 去重（取 volume 最高那条），按搜索量降序取 TOP N，作为全球热搜。
// 复用已加载的 byGeoDate，不额外查 D1。
function aggregateGlobal(byGeoDate, latestDate, topN) {
  /** @type {object[]} */
  const all = [];
  for (const [geo, m] of byGeoDate.entries()) {
    if (geo === 'WW') continue;
    const date = latestDate.get(geo);
    if (!date) continue;
    const items = m.get(date);
    if (Array.isArray(items)) all.push(...items);
  }

  const byKey = new Map();
  for (const it of all) {
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
    // WW 首页统一英文 summary：优先 intro_en，回退 intro。
    // keyword 仍保留原始语言（trendCard 直接用 t.keyword 渲染）。
    .map((it, i) => ({ ...it, rank: i + 1, intro: it.intro_en || it.intro || null }));
}
