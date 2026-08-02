// Thin D1 adapter layer.
//
// Goal: let the ingest / query / build scripts share one set of SQL that runs both
// locally via `wrangler d1 execute --local` and in CI via `--remote` (against the
// real Cloudflare D1).
//
// Switching: D1_REMOTE=1 uses --remote; otherwise --local.
// CI also requires:
//   CLOUDFLARE_API_TOKEN  (D1:Edit + Pages:Edit)
//   CLOUDFLARE_ACCOUNT_ID
//
// Implementation: shells out to the wrangler CLI with --json output.
// Performance note: each wrangler CLI startup takes ~1-2s, so we batch multiple
// statements into a single call.

import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const REMOTE = process.env.D1_REMOTE === '1';
const SCOPE = REMOTE ? '--remote' : '--local';

// Intermittent D1 transient errors that recover on retry.
// "Not currently importing anything" is a known wrangler --file issue: the previous
// import's state wasn't cleaned up, so D1 thinks no import is in progress.
// "Input file ... missing or invalid" is the same import-state-stuck problem.
// See https://community.cloudflare.com/t/wrangler-import-error-not-currently-importing-anything/755655
const TRANSIENT_ERROR_PATTERNS = [
  'Not currently importing anything',
  'D1 DB is overloaded',
  'D1_INTERNAL_ERROR',
  'Internal error while starting up D1 DB storage',
];
const IMPORT_STUCK_REGEX = /Input file .*\.sql missing or invalid/;
const MAX_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 2000;

function isTransientError(err) {
  const msg = String(err?.message ?? '');
  return TRANSIENT_ERROR_PATTERNS.some((p) => msg.includes(p)) || IMPORT_STUCK_REGEX.test(msg);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Run a read-only SQL statement and return the rows.
 */
export async function queryAll(sql, params = []) {
  const out = await runWrangler([
    'd1', 'execute', 'trendigger-db', SCOPE, '--json',
    '--command', bind(sql, params),
  ]);
  const rows = out?.[0]?.results ?? [];
  return rows;
}

/**
 * Batch-execute multiple write statements via --file in a single wrangler call.
 */
export async function executeBatch(statements) {
  if (!statements.length) return;
  const sqlText = statements.map((s) => bind(s.sql, s.params ?? []) + ';').join('\n');
  const tmp = join(tmpdir(), `trendigger-${randomUUID()}.sql`);
  await writeFile(tmp, sqlText, 'utf8');
  try {
    await runWrangler([
      'd1', 'execute', 'trendigger-db', SCOPE, '--file', tmp,
    ]);
  } finally {
    await rm(tmp, { force: true });
  }
}

/** Apply a schema file for initialization/migration. */
export async function applySchemaFile(filepath) {
  await runWrangler(['d1', 'execute', 'trendigger-db', SCOPE, '--file', filepath]);
}

export async function ensureLocalDir() {
  await mkdir('.wrangler', { recursive: true });
}

// ---------------------------------------------------------------------------

// Wrangler call with retry: exponential backoff for D1 transient errors.
async function runWrangler(args) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      return await runWranglerOnce(args);
    } catch (err) {
      lastErr = err;
      if (!isTransientError(err) || attempt === MAX_RETRIES) throw err;
      const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
      const firstLine = String(err.message ?? '').split('\n').find((l) => l.trim()) ?? '';
      console.warn(
        `wrangler transient error (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying in ${delay}ms: ${firstLine}`,
      );
      await sleep(delay);
    }
  }
  throw lastErr;
}

function runWranglerOnce(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['--no-install', 'wrangler', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: '1' },
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on('data', (c) => stdoutChunks.push(c));
    child.stderr.on('data', (c) => stderrChunks.push(c));
    child.on('error', reject);
    child.on('close', (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (code !== 0) {
        const err = new Error(
          `wrangler ${args.join(' ')} exited with ${code}\nSTDERR:\n${stderr}\nSTDOUT:\n${stdout}`,
        );
        return reject(err);
      }
      if (!args.includes('--json')) {
        // Non-JSON commands (e.g. --file schema execution) return no data.
        return resolve(null);
      }
      // wrangler occasionally interleaves log lines before/after the JSON; extract the
      // first JSON array/object.
      const json = extractJson(stdout);
      if (!json) {
        return reject(new Error(`Failed to parse wrangler JSON output:\n${stdout}`));
      }
      resolve(json);
    });
  });
}

function extractJson(text) {
  // Find the substring from the first '[' or '{' to its matching ']'/'}'.
  const start = Math.min(
    ...['[', '{']
      .map((c) => text.indexOf(c))
      .filter((i) => i >= 0)
      .concat(Number.POSITIVE_INFINITY),
  );
  if (!Number.isFinite(start)) return null;
  for (let end = text.length; end > start; end--) {
    const slice = text.slice(start, end);
    try { return JSON.parse(slice); } catch {}
  }
  return null;
}

// ---------------------------------------------------------------------------
// SQL parameter binding: wrangler CLI's --command doesn't support typed ? placeholders,
// so we do safe interpolation manually. Only string / number / null are supported.
// Safety: only primitive types are accepted; strings are escaped per SQLite text rules
// ('' doubled).
export function bind(sql, params) {
  if (!params.length) return sql;
  let i = 0;
  return sql.replace(/\?/g, () => {
    if (i >= params.length) throw new Error('Not enough params for SQL');
    const v = params[i++];
    return toSqlLiteral(v);
  });
}

function toSqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('Non-finite number');
    return String(v);
  }
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'string') return `'${v.replace(/'/g, "''")}'`;
  throw new Error(`Unsupported SQL param type: ${typeof v}`);
}
