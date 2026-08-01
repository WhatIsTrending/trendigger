// 从 D1 读取并漂亮打印某天某 geo 的 trends（取当天每个 keyword 的峰值快照）。
// 用法:
//   node src/query.js                    # 今天 UTC + US
//   node src/query.js US 2026-04-26
//   node src/query.js JP
//   node src/query.js --stats            # 打印整体统计
//   node src/query.js --log 20           # 最近 20 条 collection_runs
import { queryAll } from './db.js';
import { GEO_BY_CODE } from './geos.js';

const args = process.argv.slice(2);

if (args.includes('--stats')) {
  await printStats();
  process.exit(0);
}

const logIdx = args.indexOf('--log');
if (logIdx >= 0) {
  const n = Number(args[logIdx + 1]) || 20;
  await printFetchLog(n);
  process.exit(0);
}

const geo = args[0] || 'US';
const date = args[1] || new Date().toISOString().slice(0, 10);
const geoMeta = GEO_BY_CODE[geo];
if (!geoMeta) { console.error(`Unknown geo: ${geo}`); process.exit(1); }

const rows = await queryAll(
  `SELECT t.keyword, t.search_volume_num, t.search_volume_raw,
          t.started_at, t.news_json, t.trend_breakdown_json, t.explore_url,
          i.intro AS intro, i.lang AS intro_lang
     FROM (
       SELECT s.date, s.geo, s.query AS keyword,
              s.search_volume AS search_volume_num,
              s.search_volume_label AS search_volume_raw,
              CAST(strftime('%s', s.started_at) AS INTEGER) AS started_at,
              s.news_json, s.trend_breakdown_json, s.explore_url,
              ROW_NUMBER() OVER (
                PARTITION BY s.geo, s.date, s.query
                ORDER BY s.search_volume DESC, s.observed_at DESC
              ) AS rn
         FROM trend_snapshots s
        WHERE s.geo = ? AND s.date = ?
     ) t
     LEFT JOIN keyword_intro i
       ON i.keyword = t.keyword AND i.geo = t.geo
    WHERE t.rn = 1
    ORDER BY t.search_volume_num DESC`,
  [geo, date],
);

console.log(`\n${geoMeta.name} (${geo}) — ${date}   [${rows.length} trends]\n`);
rows.forEach((r, i) => {
  const vol = r.search_volume_raw || `${r.search_volume_num}+`;
  const started = r.started_at
    ? new Date(r.started_at * 1000).toISOString().slice(11, 16) + ' UTC'
    : 'n/a';
  const news = safeJson(r.news_json, []);
  const breakdown = safeJson(r.trend_breakdown_json, []);
  console.log(`#${String(i + 1).padStart(2)}  ${r.keyword}   [peak ${vol} · started ${started}]`);
  if (breakdown.length) {
    console.log(`     breakdown: ${breakdown.join(', ')}`);
  }
  if (r.intro) {
    console.log(wrap(r.intro, 88, '     '));
  } else {
    console.log('     (no intro yet — run: npm run enrich)');
  }
  for (const n of news.slice(0, 3)) {
    const src = n.sources?.length ? n.sources.join(', ') : (n.source || '(src?)');
    console.log(`     • ${n.title}  — ${src}`);
  }
  if (news.length > 3) console.log(`     … and ${news.length - 3} more news`);
  console.log();
});

async function printStats() {
  const rows = await queryAll(
    `SELECT date, geo, COUNT(DISTINCT query) AS n, MAX(observed_at) AS latest
       FROM trend_snapshots GROUP BY date, geo ORDER BY date DESC, geo ASC`,
    [],
  );
  console.log(`\n${rows.length} (date, geo) buckets in DB:\n`);
  for (const r of rows) {
    console.log(`  ${r.date}  ${r.geo.padEnd(3)}  ${String(r.n).padStart(3)} trends   last updated ${r.latest}`);
  }
}

async function printFetchLog(n) {
  const rows = await queryAll(
    `SELECT run_id, geo, observed_at, item_count, fetch_status, error
       FROM collection_runs ORDER BY run_id DESC LIMIT ?`,
    [n],
  );
  console.log(`\nLast ${rows.length} collection runs:\n`);
  for (const r of rows) {
    const flag = r.fetch_status === 'success' ? 'OK ' : 'ERR';
    console.log(`  #${r.run_id}  ${r.observed_at}  ${r.geo.padEnd(3)}  ${flag}  items=${r.item_count}${r.error ? '  ' + r.error : ''}`);
  }
}

function safeJson(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

function wrap(text, width, prefix) {
  const hasSpaces = /\s/.test(text);
  const chunks = [];
  if (hasSpaces) {
    let line = '';
    for (const word of text.split(/\s+/)) {
      if ((line + ' ' + word).trim().length > width) {
        chunks.push(line);
        line = word;
      } else {
        line = line ? line + ' ' + word : word;
      }
    }
    if (line) chunks.push(line);
  } else {
    for (let i = 0; i < text.length; i += width) {
      chunks.push(text.slice(i, i + width));
    }
  }
  return chunks.map((l) => prefix + l).join('\n');
}
