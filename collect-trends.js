// Collect Google Trends Trending Now into D1 via the `google-trends-now` lib.
//
// Design:
//   * Fetch each geo every 4h (Google's finest granularity), producing one collection_runs row.
//   * One trend_snapshots row per trend keyword (no daily UPSERT merging).
//   * For the top N trends, call fetchTrendingNews(news_refs) to get news + gstatic thumbnails.
//   * Write to D1 via wrangler: --local locally, --remote in CI (D1_REMOTE=1).
//   * No SerpAPI / RSS; google-trends-now is the sole data source.
//
// Usage:
//   node collect-trends.js                          # all default geos, hours=4
//   node collect-trends.js --geos US,JP --hours 4
//   node collect-trends.js --with-news 20           # resolve news for top 20 trends (default 20)
//   node collect-trends.js --limit 100 --delay-ms 1500
//   node collect-trends.js --help

import { fetchTrendingNow, fetchTrendingNews } from 'google-trends-now';
import { executeBatch, queryAll } from './src/db.js';
import { dedupeNews } from './src/dedupeNews.js';
import { parseVolume } from './src/parseVolume.js';
import { GEOS, GEO_BY_CODE } from './src/geos.js';

const DEFAULT_GEOS = GEOS.map((g) => g.code);
const VALID_HOURS = new Set([4, 24, 48, 168]);
const VALID_STATUS = new Set(['all', 'active', 'ended']);
const VALID_SORT = new Set(['relevance', 'volume', 'recency', 'title']);

function parseArgs(argv) {
  const opts = {
    geos: DEFAULT_GEOS,
    hours: 4,
    category: 'all',
    status: 'all',
    sort: 'relevance',
    limit: 100,
    hl: 'en',
    timeoutMs: 30000,
    retries: 1,
    delayMs: 1500,
    withNews: 20,
    includeRaw: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    const [rawKey, inlineValue] = arg.slice(2).split('=', 2);
    const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    let value = inlineValue;
    if (value === undefined && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      value = argv[i + 1];
      i += 1;
    }
    if (value === undefined) value = 'true';

    switch (key) {
      case 'geos':
        opts.geos = value.split(',').map((g) => g.trim().toUpperCase()).filter(Boolean);
        break;
      case 'hours':
      case 'timeoutMs':
      case 'retries':
      case 'delayMs':
      case 'withNews':
        opts[key] = Number.parseInt(value, 10);
        break;
      case 'limit':
        opts.limit = value === 'all' ? 'all' : Number.parseInt(value, 10);
        break;
      case 'includeRaw':
        opts.includeRaw = ['1', 'true', 'yes', 'y'].includes(String(value).toLowerCase());
        break;
      case 'category':
      case 'status':
      case 'sort':
      case 'hl':
        opts[key] = value;
        break;
      default:
        throw new Error(`Unknown option: --${rawKey}`);
    }
  }

  if (!opts.help) {
    if (opts.geos.length === 0) throw new Error('At least one geo code is required.');
    if (!VALID_HOURS.has(opts.hours)) throw new Error('--hours must be one of 4, 24, 48, 168.');
    if (!VALID_STATUS.has(opts.status)) throw new Error('--status must be one of all, active, ended.');
    if (!VALID_SORT.has(opts.sort)) throw new Error('--sort must be one of relevance, volume, recency, title.');
    if (opts.limit !== 'all' && (!Number.isInteger(opts.limit) || opts.limit < 1))
      throw new Error('--limit must be a positive integer or all.');
    for (const key of ['timeoutMs', 'retries', 'delayMs', 'withNews']) {
      if (!Number.isInteger(opts[key]) || opts[key] < 0)
        throw new Error(`--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} must be a non-negative integer.`);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`Usage: node collect-trends.js [options]

Collect Google Trends Trending Now into D1 via google-trends-now.

Options:
  --geos US,JP,DE        Country/region codes. Default: all ${GEOS.length} geos
  --hours 4              Started trending window: 4, 24, 48, 168. Default: 4
  --category all         Google Trends category alias/id. Default: all
  --status all           all, active, or ended. Default: all
  --sort relevance       relevance, volume, recency, title. Default: relevance
  --limit 100            Rows per geo, or all. Default: 100
  --hl en                Locale. Default: en
  --with-news 20         Resolve news+gstatic thumbnail for top N trends per geo. Default: 20
  --delay-ms 1500        Delay between geos. Default: 1500
  --retries 1            Retries for transient 429/5xx. Default: 1
  --timeout-ms 30000     Request timeout. Default: 30000
  --include-raw true     Store raw item JSON. Default: false

Environment:
  D1_REMOTE=1            Use remote D1 (CI). Otherwise local .wrangler.
`);
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function trendStatus(item) {
  if (item.active === false) return 'ended';
  return 'active';
}

function mapNewsArticles(articles) {
  // google-trends-now article -> dedupeNews input shape
  return (articles || []).map((a) => ({
    title: a.title || '',
    url: a.url || '',
    source: a.source || '',
    snippet: null,
    picture: a.thumbnail_url || null,
    sources: a.source ? [a.source] : [],
  }));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Convert the UTC observed_at to the geo's local date ('YYYY-MM-DD').
// Use the local date as the "day" grouping key, so US 7/29 = the full US-local 7/29,
// rather than UTC 7/29 (which would span two local days for the Americas).
function localDate(observedAtUtc, tz) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz || 'UTC',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(observedAtUtc));
  } catch {
    return observedAtUtc.slice(0, 10);
  }
}

async function collectGeo(opts, geo) {
  const geoMeta = GEO_BY_CODE[geo];
  // fetchGeo=null means this geo can't be fetched directly (WW: google-trends-now returns
  // 0 rows for geo=''); it's aggregated from other geos at build time, so skip it here.
  if (geoMeta?.fetchGeo === null) {
    console.log(`${geo}: aggregated from other geos at build time, skipping fetch`);
    return { itemCount: 0, fetchStatus: 'skipped' };
  }
  // Other geos: fall back to the code itself when fetchGeo isn't explicitly configured.
  const fetchGeo = geoMeta?.fetchGeo ?? geo;
  const result = await fetchTrendingNow({
    geo: fetchGeo,
    hours: opts.hours,
    category: opts.category,
    status: opts.status,
    sort: opts.sort,
    limit: opts.limit,
    hl: opts.hl,
    fallback: 'none', // Per request: only use google-trends-now, no RSS fallback.
    timeoutMs: opts.timeoutMs,
    retries: opts.retries,
    includeRaw: opts.includeRaw,
  });

  const observedAt = result.observed_at;
  const date = localDate(observedAt, geoMeta?.tz);
  const items = normalizeArray(result.items);

  if (result.fetch_status !== 'success' || items.length === 0) {
    // Still record a failed run for audit purposes.
    await executeBatch([{
      sql: `INSERT INTO collection_runs
              (observed_at, date, geo, hours, category, status_filter, sort,
               source, fetch_status, source_url, error, item_count)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        observedAt, date, geo, opts.hours, opts.category, opts.status, opts.sort,
        result.source, result.fetch_status, result.source_url,
        result.error ? String(result.error) : 'no items', 0,
      ],
    }]);
    console.warn(`${geo}: fetch_status=${result.fetch_status}, items=0 (${result.error ?? 'no items'})`);
    return { itemCount: 0, fetchStatus: result.fetch_status };
  }

  // 1) Write collection_runs first and get back run_id.
  await executeBatch([{
    sql: `INSERT INTO collection_runs
            (observed_at, date, geo, hours, category, status_filter, sort,
             source, fetch_status, source_url, error, item_count)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      observedAt, date, geo, opts.hours, opts.category, opts.status, opts.sort,
      result.source, result.fetch_status, result.source_url, result.error, items.length,
    ],
  }]);
  const runRows = await queryAll(
    `SELECT MAX(run_id) AS id FROM collection_runs WHERE geo = ? AND observed_at = ?`,
    [geo, observedAt],
  );
  const runId = runRows[0]?.id;
  if (!runId) throw new Error(`Could not retrieve run_id for geo=${geo} observed_at=${observedAt}`);

  // 2) Resolve news + gstatic thumbnail for the top withNews trends.
  const withNewsCount = Math.min(opts.withNews, items.length);
  const newsByPosition = new Map();
  for (let i = 0; i < withNewsCount; i += 1) {
    const item = items[i];
    const refs = normalizeArray(item.news_refs);
    if (!refs.length) continue;
    try {
      const articles = await fetchTrendingNews(refs.slice(0, 5), {
        hl: opts.hl, geo: fetchGeo, timeoutMs: opts.timeoutMs, retries: opts.retries,
      });
      newsByPosition.set(i, articles);
    } catch (err) {
      console.warn(`${geo}: fetchTrendingNews failed for #${i + 1} "${item.query}": ${err.message}`);
    }
    if (i < withNewsCount - 1 && opts.delayMs > 0) await sleep(Math.min(opts.delayMs, 800));
  }

  // 3) Build the trend_snapshots batch INSERT.
  const stmts = items.map((item, idx) => {
    const breakdown = normalizeArray(item.trend_breakdown);
    const categories = normalizeArray(item.categories);
    const articles = newsByPosition.get(idx);
    const news = articles ? dedupeNews(mapNewsArticles(articles)) : [];
    // Trend thumbnail: take the gstatic thumbnail from the first news item that has one.
    const picture = news.find((n) => n.picture)?.picture || null;

    const volLabel = item.search_volume_label ?? (item.search_volume != null ? String(item.search_volume) : null);
    const volNum = parseVolume(volLabel);

    return {
      sql: `INSERT INTO trend_snapshots
              (run_id, observed_at, date, geo, position, raw_position, query, normalized_query,
               search_volume, search_volume_label, increase_percentage, started_at, ended_at,
               start_timestamp, end_timestamp, status, trend_breakdown_json, categories_json,
               explore_url, picture, news_json, source, raw_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        runId,
        observedAt,
        date,
        geo,
        item.position ?? idx + 1,
        item.raw_position ?? item.position ?? null,
        item.query ?? '',
        item.normalized_query ?? null,
        volNum || null,
        volLabel,
        item.increase_percentage != null ? Number(item.increase_percentage) : null,
        item.started_at ?? null,
        item.ended_at ?? null,
        item.start_timestamp ?? null,
        item.end_timestamp ?? null,
        trendStatus(item),
        JSON.stringify(breakdown),
        JSON.stringify(categories),
        item.explore_url ?? null,
        picture,
        JSON.stringify(news),
        item.source ?? result.source,
        opts.includeRaw ? JSON.stringify(item) : null,
      ],
    };
  });

  await executeBatch(stmts);
  return { itemCount: items.length, fetchStatus: result.fetch_status, runId };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { printHelp(); return; }

  console.log(`Collecting ${opts.geos.join(', ')} (hours=${opts.hours}, status=${opts.status}, sort=${opts.sort}, with-news=${opts.withNews})`);
  let failures = 0;
  for (const [index, geo] of opts.geos.entries()) {
    if (!GEO_BY_CODE[geo]) {
      console.warn(`${geo}: unknown geo, skipped`);
      continue;
    }
    try {
      const saved = await collectGeo(opts, geo);
      console.log(`${geo}: saved ${saved.itemCount} trends (run ${saved.runId ?? '-'}, ${saved.fetchStatus ?? 'unknown'})`);
    } catch (err) {
      failures += 1;
      console.error(`${geo}: ${err.message}`);
    }
    if (index < opts.geos.length - 1 && opts.delayMs > 0) await sleep(opts.delayMs);
  }
  if (failures > 0) process.exitCode = 1;
  console.log('Done.');
}

main().catch((err) => {
  console.error(err.stack ?? err.message);
  process.exitCode = 1;
});
