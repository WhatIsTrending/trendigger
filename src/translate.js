// Azure AI Translator 客户端（零依赖）。
//
// 用途：把当地语言的 keyword intro 翻译成英文，存入 keyword_intro.intro_en，
// 替代原先「再调用一次 AI 生成英文版本」的做法（省一次 AI 调用，且得到真正的翻译）。
//
// 免费层：2M 字符/月（永久），103+ 语言，无需信用卡。
// 超出后 $10/1M 字符。
//
// 自动语种检测：省略 from 参数时 Azure 会自动检测源语种，适合混合语种 summary
// （例如马来西亚 summary 里同时出现英文 / 马来文 / 中文）。
// 已经是英文的片段基本原样保留，其余部分翻译成英文。
//
// 鉴权（按优先级）：
//   1) env AZURE_TRANSLATOR_KEY        （或 AZURE_API_KEY 兼容）
//   2) env AZURE_TRANSLATOR_REGION     （如 "eastus"、"global"）
//
// 用法：
//   import { translate } from './translate.js';
//   const en = await translate('你好', { to: 'en' });

const AZURE_BASE = 'https://api.cognitive.microsofttranslator.com';
const API_VERSION = '3.0';

const PROVIDER = (process.env.TRANSLATE_PROVIDER || 'azure').toLowerCase();

function loadKey() {
  if (process.env.AZURE_TRANSLATOR_KEY) return process.env.AZURE_TRANSLATOR_KEY;
  if (process.env.AZURE_API_KEY) return process.env.AZURE_API_KEY;
  throw new Error('Azure Translator requires AZURE_TRANSLATOR_KEY env var');
}

function loadRegion() {
  const r = process.env.AZURE_TRANSLATOR_REGION;
  if (!r) throw new Error('Azure Translator requires AZURE_TRANSLATOR_REGION env var (e.g. "eastus")');
  return r;
}

/**
 * 翻译文本。from 省略时自动检测源语种（适合混合语种 summary）。
 * @param {string} text
 * @param {{to?: string, from?: string, timeoutMs?: number}} [opts]
 * @returns {Promise<string>} 译文
 */
export async function translate(text, opts = {}) {
  if (PROVIDER === 'none') {
    throw new Error('TRANSLATE_PROVIDER=none: translation disabled');
  }
  const to = opts.to || 'en';
  const from = opts.from; // 省略 → 自动检测
  const timeoutMs = opts.timeoutMs ?? 30_000;

  if (!text || !text.trim()) return '';
  if (from && from === to) return text; // 同语种免调

  return azureTranslate(text, { to, from, timeoutMs });
}

async function azureTranslate(text, { to, from, timeoutMs }) {
  const key = loadKey();
  const region = loadRegion();

  const params = new URLSearchParams({ 'api-version': API_VERSION });
  params.set('to', to);
  if (from) params.set('from', from);

  const url = `${AZURE_BASE}/translate?${params}`;
  const body = JSON.stringify([{ Text: text }]);

  const resText = await fetchWithRetry(url, body, key, region, timeoutMs);
  const parsed = JSON.parse(resText);

  if (parsed.error) {
    throw new Error(`Azure Translator error: ${parsed.error.message || JSON.stringify(parsed.error)}`);
  }

  const translation = parsed?.[0]?.translations?.[0]?.text;
  if (!translation) throw new Error('Azure Translator returned no translation');
  return translation;
}

async function fetchWithRetry(url, body, key, region, timeoutMs) {
  const maxAttempts = 3;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'Ocp-Apim-Subscription-Key': key,
          'Ocp-Apim-Subscription-Region': region,
        },
        body,
        signal: controller.signal,
      });
      const text = await res.text();
      if (res.ok) return text;

      if (res.status === 401) {
        throw new Error(
          `Azure Translator 401: auth failed. ` +
          `Check AZURE_TRANSLATOR_KEY / AZURE_TRANSLATOR_REGION. ` +
          `Response: ${text.slice(0, 300)}`,
        );
      }
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
        // 429 时等更久，给配额窗口清空
        await sleep(res.status === 429 ? 15000 : backoff(attempt));
        continue;
      }
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
    } catch (err) {
      lastErr = err;
      if (err.name === 'AbortError') {
        lastErr = new Error(`Azure Translator request timed out after ${timeoutMs}ms`);
      }
      if (attempt < maxAttempts) await sleep(backoff(attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr ?? new Error('Unknown Azure Translator failure');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoff = (attempt) => (attempt === 1 ? 2000 : 5000) + Math.floor(Math.random() * 500);
