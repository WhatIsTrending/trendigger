// D1 薄适配层。
//
// 目标：让 ingest / query / build 脚本用同一组 SQL，
// 既能在本地通过 `wrangler d1 execute --local` 跑，
// 也能在 CI 里通过 `--remote` 跑（连真实 Cloudflare D1）。
//
// 切换：环境变量 D1_REMOTE=1 时使用 --remote，否则 --local。
// CI 还需要设置:
//   CLOUDFLARE_API_TOKEN  (D1:Edit + Pages:Edit)
//   CLOUDFLARE_ACCOUNT_ID
//
// 本地实现：调用 wrangler CLI 子进程，--json 输出。
// 性能说明：wrangler CLI 每次启动约 1-2s。我们用 batch 把多条 statement 拼在一次调用里。

import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const REMOTE = process.env.D1_REMOTE === '1';
const SCOPE = REMOTE ? '--remote' : '--local';

/**
 * 执行一条只读 SQL 并返回行数组。
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
 * 批量执行多条写语句，在单次 wrangler 调用里用 --file。
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

/** 对初始化/迁移用的 schema 文件。 */
export async function applySchemaFile(filepath) {
  await runWrangler(['d1', 'execute', 'trendigger-db', SCOPE, '--file', filepath]);
}

export async function ensureLocalDir() {
  await mkdir('.wrangler', { recursive: true });
}

// ---------------------------------------------------------------------------

function runWrangler(args) {
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
        // 非 JSON 命令（如 --file 执行 schema）无需返回数据
        return resolve(null);
      }
      // wrangler 偶尔在 JSON 前后夹杂日志行；抽取第一个 JSON 数组/对象。
      const json = extractJson(stdout);
      if (!json) {
        return reject(new Error(`Failed to parse wrangler JSON output:\n${stdout}`));
      }
      resolve(json);
    });
  });
}

function extractJson(text) {
  // 找到第一个 '[' 或 '{' 到匹配的 ']'/'}' 的子串
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
// SQL 参数绑定：wrangler CLI 的 --command 不支持 ? 占位符的类型化绑定，
// 我们手动做安全插值。只支持 string / number / null。
// 安全性：只接受基础类型；字符串按 SQLite 文本转义（'' 双写）。
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
