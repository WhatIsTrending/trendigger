// 删掉超过保留期的快照数据。
// 默认保留 365 天，可用 --days N 覆盖。
// keyword_intro 不删（缓存，比 365 天还稀缺，省 API 调用）。
//
// 新 schema：trend_snapshots 按 date 删，collection_runs 按 date 删
// （FK ON DELETE CASCADE 理论上会级联，但 D1 不一定默认开 PRAGMA foreign_keys，
//  两张表都显式删最稳）。

import { queryAll, executeBatch } from './db.js';

const args = process.argv.slice(2);
const daysArg = args.indexOf('--days');
const RETENTION_DAYS = daysArg >= 0 ? Number(args[daysArg + 1]) : 365;

if (!Number.isFinite(RETENTION_DAYS) || RETENTION_DAYS < 1) {
  console.error('Invalid --days');
  process.exit(1);
}

const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400_000)
  .toISOString()
  .slice(0, 10);

const beforeSnap = await queryAll(
  `SELECT COUNT(*) AS n FROM trend_snapshots WHERE date < ?`,
  [cutoff],
);
const beforeRun = await queryAll(
  `SELECT COUNT(*) AS n FROM collection_runs WHERE date < ?`,
  [cutoff],
);
const snapN = beforeSnap[0]?.n ?? 0;
const runN = beforeRun[0]?.n ?? 0;

if (snapN === 0 && runN === 0) {
  console.log(`Retention ${RETENTION_DAYS}d (cutoff ${cutoff}): nothing to prune.`);
  process.exit(0);
}

console.log(`Pruning ${snapN} snapshots + ${runN} runs older than ${cutoff}...`);
await executeBatch([
  { sql: `DELETE FROM trend_snapshots WHERE date < ?`, params: [cutoff] },
  { sql: `DELETE FROM collection_runs WHERE date < ?`, params: [cutoff] },
]);
console.log('Done.');
