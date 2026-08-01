// 翻译客户端（零依赖）。
//
// 用途：把当地语言的 keyword intro 翻译成英文，存入 keyword_intro.intro_en，
// 替代原先「再调用一次 AI 生成英文版本」的做法（省一次 AI 调用，且得到真正的翻译）。
//
// 分层路由（enrich 调用时通过 opts.tier 指定）：
//   - tier='azure'  → Azure AI Translator（高质量，免费层 2M 字符/月）
//                     用于每个非英语 geo 的 top-N 关键词（默认 10）。
//   - tier='google' → Google Translate 免费 gtx 端点（与 Python googletrans 同源）
//                     无配额上限但可能被限流；用于 top-N 之外的剩余关键词。
//   - tier='none' / TRANSLATE_PROVIDER=none → 禁用翻译。
//
// 自动语种检测：两个 provider 都省略源语种自动检测，适合混合语种 summary
// （例如马来西亚 summary 里同时出现英文 / 马来文 / 中文）。
// 已经是英文的片段基本原样保留，其余部分翻译成英文。
//
// Azure 鉴权（按优先级）：
//   1) env AZURE_TRANSLATOR_KEY        （或 AZURE_API_KEY 兼容）
//   2) env AZURE_TRANSLATOR_REGION     （如 "westus2"、"eastus"、"global"）
//
// 用法：
//   import { translate } from './translate.js';
//   const en = await translate('你好', { tier: 'azure', to: 'en' });

const AZURE_BASE = 'https://api.cognitive.microsofttranslator.com';
const API_VERSION = '3.0';
const GOOGLE_GTX = 'https://translate.googleapis.com/translate_a/single';

const PROVIDER = (process.env.TRANSLATE_PROVIDER || 'azure').toLowerCase();

/**
 * 翻译文本。from 省略时自动检测源语种（适合混合语种 summary）。
 * @param {string} text
 * @param {{to?: string, from?: string, tier?: 'azure'|'google'|'none', timeoutMs?: number}} [opts]
 * @returns {Promise<string>} 译文
 */
export async function translate(text, opts = {}) {
  const to = opts.to || 'en';
  const from = opts.from; // 省略 → 自动检测
  const tier = (opts.tier || (PROVIDER === 'none' ? 'none' : 'azure')).toLowerCase();

  if (!text || !text.trim()) return '';
  if (from && from === to) return text; // 同语种免调

  if (tier === 'none' || PROVIDER === 'none') {
    throw new Error('translation disabled (tier=none)');
  }
  if (tier === 'google') return googleTranslate(text, { to, timeoutMs: opts.timeoutMs });
  return azureTranslate(text, { to, from, timeoutMs: opts.timeoutMs });
}

// ---------------------------------------------------------------------------
// Azure AI Translator
// ---------------------------------------------------------------------------

function loadAzureKey() {
  if (process.env.AZURE_TRANSLATOR_KEY) return process.env.AZURE_TRANSLATOR_KEY;
  if (process.env.AZURE_API_KEY) return process.env.AZURE_API_KEY;
  throw new Error('Azure Translator requires AZURE_TRANSLATOR_KEY env var');
}

function loadAzureRegion() {
  const r = process.env.AZURE_TRANSLATOR_REGION;
  if (!r) throw new Error('Azure Translator requires AZURE_TRANSLATOR_REGION env var (e.g. "westus2")');
  return r;
}

async function azureTranslate(text, { to, from, timeoutMs }) {
  const key = loadAzureKey();
  const region = loadAzureRegion();

  const params = new URLSearchParams({ 'api-version': API_VERSION });
  params.set('to', to);
  if (from) params.set('from', from);

  const url = `${AZURE_BASE}/translate?${params}`;
  const body = JSON.stringify([{ Text: text }]);

  const resText = await fetchWithRetry(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'Ocp-Apim-Subscription-Key': key,
      'Ocp-Apim-Subscription-Region': region,
    },
    body,
    timeoutMs,
    isRetryable: (status) => status === 429 || status >= 500,
    retryDelay: (status) => (status === 429 ? 15000 : undefined),
  });

  const parsed = JSON.parse(resText);
  if (parsed.error) {
    throw new Error(`Azure Translator error: ${parsed.error.message || JSON.stringify(parsed.error)}`);
  }
  const translation = parsed?.[0]?.translations?.[0]?.text;
  if (!translation) throw new Error('Azure Translator returned no translation');
  return translation;
}

// ---------------------------------------------------------------------------
// Google Translate（免费 gtx 端点，与 Python googletrans 同源）
// ---------------------------------------------------------------------------

async function googleTranslate(text, { to, timeoutMs = 30000 }) {
  // gtx 端点用 GET，URL 过长会被截断；超长文本拆段翻译再拼接。
  const MAX_LEN = 1800;
  if (text.length <= MAX_LEN) return googleTranslateChunk(text, to, timeoutMs);

  const chunks = splitText(text, MAX_LEN);
  const out = [];
  for (const chunk of chunks) out.push(await googleTranslateChunk(chunk, to, timeoutMs));
  return out.join('');
}

async function googleTranslateChunk(text, to, timeoutMs) {
  const url = `${GOOGLE_GTX}?client=gtx&sl=auto&tl=${encodeURIComponent(to)}&dt=t&q=${encodeURIComponent(text)}`;
  const resText = await fetchWithRetry(url, { timeoutMs, isRetryable: (status) => status === 429 || status >= 500 });
  const parsed = JSON.parse(resText);
  // parsed[0] = [[translatedChunk, originalChunk, ...], ...]
  const segments = Array.isArray(parsed[0]) ? parsed[0] : [];
  const translation = segments.map((seg) => (seg && seg[0]) || '').join('');
  if (!translation) throw new Error('Google Translate returned no translation');
  return translation;
}

function splitText(text, maxLen) {
  // 按句子边界拆分，尽量不硬切断。
  const parts = text.split(/(?<=[.!?。！？\n])\s+/);
  const chunks = [];
  let cur = '';
  for (const p of parts) {
    if ((cur + p).length > maxLen && cur) {
      chunks.push(cur);
      cur = p;
    } else {
      cur += (cur ? ' ' : '') + p;
    }
    while (cur.length > maxLen) {
      chunks.push(cur.slice(0, maxLen));
      cur = cur.slice(maxLen);
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

// ---------------------------------------------------------------------------
// 共享 fetch + 重试
// ---------------------------------------------------------------------------

async function fetchWithRetry(url, opts) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 30000,
    isRetryable = (status) => status === 429 || status >= 500,
    retryDelay,
  } = opts;
  const maxAttempts = 4;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method, headers, body, signal: controller.signal });
      const text = await res.text();
      if (res.ok) return text;

      if (res.status === 401) {
        throw new Error(`401 auth failed: ${text.slice(0, 200)}`);
      }
      if (res.status === 429) {
        // Google gtx 限流：用响应里的 Retry-After 或退避更久
        const ra = res.headers.get('retry-after');
        lastErr = new Error(`429 rate limited: ${text.slice(0, 120)}`);
        await sleep(ra ? Number(ra) * 1000 : (retryDelay ? retryDelay(429) : backoff(attempt) + 2000));
        continue;
      }
      if (isRetryable(res.status)) {
        lastErr = new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`);
        await sleep(retryDelay ? retryDelay(res.status) ?? backoff(attempt) : backoff(attempt));
        continue;
      }
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    } catch (err) {
      lastErr = err;
      if (err.name === 'AbortError') {
        lastErr = new Error(`request timed out after ${timeoutMs}ms`);
      }
      // 401 等不可重试错误直接抛
      if (String(err.message).startsWith('401')) throw err;
      if (attempt < maxAttempts) await sleep(backoff(attempt) + 1000);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr ?? new Error('Unknown translation failure');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoff = (attempt) => (attempt === 1 ? 1500 : 4000) + Math.floor(Math.random() * 800);
