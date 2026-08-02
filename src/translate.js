// Translation client (zero dependencies).
//
// Purpose: translate local-language keyword intros into English and store them in
// keyword_intro.intro_en, replacing the previous approach of calling the AI again
// to generate an English version (saves one AI call and produces a real translation).
//
// Tiered routing (set via opts.tier when called from enrich):
//   - tier='azure'  → Azure AI Translator (high quality, free tier 2M chars/month)
//                     used for the top-N keywords per non-English geo (default 10).
//   - tier='google' → Google Translate free gtx endpoint (same source as Python googletrans)
//                     no quota cap but may be throttled; used for the remaining keywords beyond top-N.
//   - tier='none' / TRANSLATE_PROVIDER=none → disable translation.
//
// Auto language detection: both providers auto-detect the source language, suitable for
// mixed-language summaries (e.g. a Malaysia summary may mix English / Malay / Chinese).
// Segments already in English are mostly returned as-is; the rest is translated to English.
//
// Azure auth (in priority order):
//   1) env AZURE_TRANSLATOR_KEY        (or AZURE_API_KEY for compatibility)
//   2) env AZURE_TRANSLATOR_REGION     (e.g. "westus2", "eastus", "global")
//
// Usage:
//   import { translate } from './translate.js';
//   const en = await translate('你好', { tier: 'azure', to: 'en' });

const AZURE_BASE = 'https://api.cognitive.microsofttranslator.com';
const API_VERSION = '3.0';
const GOOGLE_GTX = 'https://translate.googleapis.com/translate_a/single';

const PROVIDER = (process.env.TRANSLATE_PROVIDER || 'azure').toLowerCase();

// Circuit breaker: when Azure's free 2M chars/month quota is exhausted it returns 403 (code 403001).
// Once hit, skip all remaining azure calls this run and fall back to Google,
// to avoid wasting time retrying every item.
let azureQuotaExhausted = false;

// Detect Azure free-quota exhaustion: HTTP 403 with a body containing quota / 403001.
// (403 may also indicate a region error, but those bodies don't contain the quota
// keyword, so the breaker won't trip mistakenly.)
function looksLikeAzureQuotaError(status, body) {
  if (status !== 403) return false;
  const msg = String(body || '').toLowerCase();
  return msg.includes('quota') || msg.includes('403001');
}

/**
 * Translate text. When `from` is omitted the source language is auto-detected
 * (suitable for mixed-language summaries).
 * @param {string} text
 * @param {{to?: string, from?: string, tier?: 'azure'|'google'|'none', timeoutMs?: number}} [opts]
 * @returns {Promise<string>} translated text
 */
export async function translate(text, opts = {}) {
  const to = opts.to || 'en';
  const from = opts.from; // Provided when the source language is known; used as a fallback when auto-detect misfires.
  const tier = (opts.tier || (PROVIDER === 'none' ? 'none' : 'azure')).toLowerCase();
  const timeoutMs = opts.timeoutMs;

  if (!text || !text.trim()) return '';
  if (from && from === to) return text; // Same language: skip the call.

  if (tier === 'none' || PROVIDER === 'none') {
    throw new Error('translation disabled (tier=none)');
  }

  // Single translation: pick provider by tier; on tier='azure' failure (including quota
  // exhaustion) fall back to google.
  async function once(useFrom) {
    const f = useFrom ? from : undefined;
    if (tier === 'azure' && !azureQuotaExhausted) {
      try {
        return await azureTranslate(text, { to, from: f, timeoutMs });
      } catch (err) {
        // If quota is exhausted the breaker is already open — don't warn again;
        // for other azure errors, fall back to google for this single call.
        if (!azureQuotaExhausted) {
          console.warn(`  ⚠ Azure translate failed, fallback to google: ${err.message}`);
        }
      }
    }
    return googleTranslate(text, { to, from: f, timeoutMs });
  }

  // First attempt: auto-detect the source language (handles mixed-language summaries).
  const first = await once(false);

  // If the translation equals the original, the source may already be the target language,
  // or auto-detect misfired (e.g. Google gtx misclassifies German as English and returns it
  // untranslated). When `from` is provided and differs from `to`, retry once with the explicit
  // source language to force translation; if it still matches, accept that the original was
  // already in the target language.
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
// Google Translate (free gtx endpoint, same source as Python googletrans)
// ---------------------------------------------------------------------------

async function googleTranslate(text, { to, from, timeoutMs = 30000 }) {
  // The gtx endpoint uses GET; overly long URLs get truncated, so split long
  // text into chunks, translate each, then concatenate.
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
  // Split on sentence boundaries where possible to avoid hard-cutting sentences.
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
// Shared fetch + retry
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
        // Google gtx throttle: honor Retry-After from the response, or back off longer.
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
      // Non-retryable HTTP error (e.g. 403 quota exhausted): notify the callback,
      // then throw with noRetry set so the catch block doesn't treat it as retryable
      // and back off 4 times (wastes time and delays alerting).
      if (onError) onError(res.status, text);
      const fatal = new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
      fatal.noRetry = true;
      throw fatal;
    } catch (err) {
      lastErr = err;
      if (err.name === 'AbortError') {
        lastErr = new Error(`request timed out after ${timeoutMs}ms`);
      }
      // Non-retryable errors (401 auth, 403 quota, anything flagged noRetry) throw
      // immediately without backing off.
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

// Whether the translation is effectively identical to the original (ignoring
// surrounding whitespace). Used to detect "returned untranslated" caused by
// auto-detect misfires.
function sameText(a, b) {
  return (a || '').trim() === (b || '').trim();
}

// Normalize the lang code used by enrich (e.g. zh-HK, pt-BR) to the form each
// translation provider accepts. Google gtx uses ISO 639-1 / regional variants;
// Azure uses the BCP-47 Hans/Hant form.
function normalizeLang(lang, provider) {
  if (!lang) return lang;
  const l = String(lang).toLowerCase();
  if (l === 'zh-hk' || l === 'zh-tw') return provider === 'google' ? 'zh-TW' : 'zh-Hant';
  if (l === 'zh-cn') return provider === 'google' ? 'zh-CN' : 'zh-Hans';
  if (l === 'pt-br' && provider === 'google') return 'pt';
  return lang;
}
