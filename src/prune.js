// Delete snapshot data older than the retention window.
// Default retention is 365 days; override with --days N.
// keyword_intro is never pruned (cached data is scarcer than 365d, saves API calls).
//
// New schema: delete from trend_snapshots by date and collection_runs by date.
// (FK ON DELETE CASCADE would theoretically cascade, but D1 may not enable
//  PRAGMA foreign_keys by default — explicitly deleting both tables is safest.)

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
