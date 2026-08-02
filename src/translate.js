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

// Circuit breaker：Azure 免费层 2M 字符/月耗尽后返回 403（code 403001）。
// 一旦命中，本轮剩余所有 azure 调用直接跳过，回退到 Google，避免每条都重试浪费时间。
let azureQuotaExhausted = false;

// 识别 Azure 免费配额耗尽错误：HTTP 403 + body 含 quota / 403001。
// （403 也可能是 region 错误，但那种 body 不含 quota 关键词，不会误触发 breaker。）
function looksLikeAzureQuotaError(status, body) {
  if (status !== 403) return false;
  const msg = String(body || '').toLowerCase();
  return msg.includes('quota') || msg.includes('403001');
}

/**
 * 翻译文本。from 省略时自动检测源语种（适合混合语种 summary）。
 * @param {string} text
 * @param {{to?: string, from?: string, tier?: 'azure'|'google'|'none', timeoutMs?: number}} [opts]
 * @returns {Promise<string>} 译文
 */
export async function translate(text, opts = {}) {
  const to = opts.to || 'en';
  const from = opts.from; // 已知源语种时传入，用作 auto 误判时的纠错后备
  const tier = (opts.tier || (PROVIDER === 'none' ? 'none' : 'azure')).toLowerCase();
  const timeoutMs = opts.timeoutMs;

  if (!text || !text.trim()) return '';
  if (from && from === to) return text; // 同语种免调

  if (tier === 'none' || PROVIDER === 'none') {
    throw new Error('translation disabled (tier=none)');
  }

  // 单次翻译：按 tier 选 provider；tier='azure' 时若失败（含配额耗尽）回退 google。
  async function once(useFrom) {
    const f = useFrom ? from : undefined;
    if (tier === 'azure' && !azureQuotaExhausted) {
      try {
        return await azureTranslate(text, { to, from: f, timeoutMs });
      } catch (err) {
        // 配额耗尽时 breaker 已打开，不重复告警；其余 azure 错误单次回退 google
        if (!azureQuotaExhausted) {
          console.warn(`  ⚠ Azure translate failed, fallback to google: ${err.message}`);
        }
      }
    }
    return googleTranslate(text, { to, from: f, timeoutMs });
  }

  // 第一次：auto 检测源语种（兼容混合语种 summary）。
  const first = await once(false);

  // 译文与原文相同：可能是原文已是目标语言，也可能是 auto 误判
  // （如 Google gtx 把德语误判成英语原样返回未翻译）。
  // 若提供了 from 且≠to，当场重试1次用显式源语种强制翻译；
  // 仍相同则认为原文确实已是目标语言，接受。
  if (from && from !== to && sameText(first, text)) {
    const retry = await once(true);
    if (!sameText(retry, text)) return retry;
  }
  return first;
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
  if (azureQuotaExhausted) {
    throw new Error('Azure Translator quota exhausted (circuit breaker open)');
  }
  const key = loadAzureKey();
  const region = loadAzureRegion();

  const params = new URLSearchParams({ 'api-version': API_VERSION });
  params.set('to', to);
  if (from) params.set('from', normalizeLang(from, 'azure'));

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
    onError: (status, respText) => {
      if (looksLikeAzureQuotaError(status, respText)) {
        azureQuotaExhausted = true;
        console.warn(
          '  ⚠ Azure Translator free quota exhausted — ' +
          'falling back to Google for the rest of this run.',
        );
      }
    },
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

async function googleTranslate(text, { to, from, timeoutMs = 30000 }) {
  // gtx 端点用 GET，URL 过长会被截断；超长文本拆段翻译再拼接。
  const MAX_LEN = 1800;
  if (text.length <= MAX_LEN) return googleTranslateChunk(text, to, from, timeoutMs);

  const chunks = splitText(text, MAX_LEN);
  const out = [];
  for (const chunk of chunks) out.push(await googleTranslateChunk(chunk, to, from, timeoutMs));
  return out.join('');
}

async function googleTranslateChunk(text, to, from, timeoutMs) {
  const sl = from ? normalizeLang(from, 'google') : 'auto';
  const url = `${GOOGLE_GTX}?client=gtx&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(to)}&dt=t&q=${encodeURIComponent(text)}`;
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
    onError,
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
      // 非重试 HTTP 错误（如 403 配额耗尽）：通知回调后抛出，并标记 noRetry
      // 避免 catch 块把它当可重试错误退避重试 4 次（浪费时间+延迟告警）。
      if (onError) onError(res.status, text);
      const fatal = new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
      fatal.noRetry = true;
      throw fatal;
    } catch (err) {
      lastErr = err;
      if (err.name === 'AbortError') {
        lastErr = new Error(`request timed out after ${timeoutMs}ms`);
      }
      // 不可重试错误（401 auth、403 quota 等标记 noRetry 的）直接抛，不退避重试
      if (err.noRetry || String(err.message).startsWith('401')) throw err;
      if (attempt < maxAttempts) await sleep(backoff(attempt) + 1000);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr ?? new Error('Unknown translation failure');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoff = (attempt) => (attempt === 1 ? 1500 : 4000) + Math.floor(Math.random() * 800);

// 译文与原文是否实质相同（忽略首尾空白）。
// 用于检测 auto 检测误判导致的"原样返回未翻译"。
function sameText(a, b) {
  return (a || '').trim() === (b || '').trim();
}

// 把 enrich 用的 lang code（如 zh-HK、pt-BR）规范成各翻译 provider 接受的代码。
// Google gtx 用 ISO 639-1 / 区域变体；Azure 用 BCP-47 的 Hans/Hant 形式。
function normalizeLang(lang, provider) {
  if (!lang) return lang;
  const l = String(lang).toLowerCase();
  if (l === 'zh-hk' || l === 'zh-tw') return provider === 'google' ? 'zh-TW' : 'zh-Hant';
  if (l === 'zh-cn') return provider === 'google' ? 'zh-CN' : 'zh-Hans';
  if (l === 'pt-br' && provider === 'google') return 'pt';
  return lang;
}
