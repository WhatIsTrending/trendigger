// Gemini API client (zero dependencies).
//
// Uses the REST API (`generateContent`) and requests JSON output to reduce parse errors.
// Default model is gemini-2.5-flash (most generous free tier).
//
// API key sources (in priority order):
//   1) opts.apiKey argument
//   2) GEMINI_API_KEY env var
//   3) contents of ./gemini-key file (convenient for local dev)
import { readFile } from 'node:fs/promises';

const DEFAULT_MODEL = 'gemini-2.5-flash';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// Language label inserted into the prompt to tell the model which language to use.
// More stable than ISO codes.
const LANG_LABEL = {
  en: 'English',
  ja: 'Japanese',
  ko: 'Korean',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  ru: 'Russian',
  'pt-BR': 'Brazilian Portuguese',
  id: 'Indonesian',
  th: 'Thai',
  vi: 'Vietnamese',
  ms: 'Malay',
  'zh-HK': 'Traditional Chinese (Hong Kong)',
  tr: 'Turkish',
  ar: 'Arabic',
};

let cachedKey = null;

// RPM rate limiter: ensure at least MIN_INTERVAL_MS between requests.
// Paid-tier flash allows 1000 RPM (~16 RPS); a 150ms interval (~400 RPM) leaves
// ample headroom to avoid throttling. Override via GEMINI_MIN_INTERVAL_MS.
const MIN_INTERVAL_MS = Number(process.env.GEMINI_MIN_INTERVAL_MS) || 150;
let lastRequestAt = 0;
let gate = Promise.resolve();
async function rateLimit() {
  // Serialization gate: concurrent callers queue up and pass through one at a time.
  const myTurn = gate.then(async () => {
    const now = Date.now();
    const wait = MIN_INTERVAL_MS - (now - lastRequestAt);
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
  });
  gate = myTurn;
  await myTurn;
}

async function loadApiKey(explicit) {
  if (explicit) return explicit;
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  if (cachedKey) return cachedKey;
  try {
    const raw = await readFile('gemini-key', 'utf8');
    cachedKey = raw.trim();
    if (cachedKey) return cachedKey;
  } catch { /* fallthrough */ }
  throw new Error(
    'No Gemini API key. Set GEMINI_API_KEY env var or create ./gemini-key',
  );
}

/**
 * Generate a 3-4 sentence intro for a keyword.
 * @param {object} input
 * @param {string} input.keyword
 * @param {string} input.geo            - 'US', 'JP', ...
 * @param {string} input.lang           - language code matching GEOS[].lang
 * @param {{title: string, sources?: string[]}[]} [input.news]
 * @param {{model?: string, apiKey?: string, timeoutMs?: number}} [opts]
 * @returns {Promise<{intro: string, model: string}>}
 */
export async function generateIntro(input, opts = {}) {
  const model = opts.model ?? DEFAULT_MODEL;
  const apiKey = await loadApiKey(opts.apiKey);
  const timeoutMs = opts.timeoutMs ?? 30_000;

  const prompt = buildPrompt(input);
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.3,
      // Force JSON for easier parsing.
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: {
          intro: { type: 'string' },
        },
        required: ['intro'],
      },
    },
    // Loosen safety filters to the most permissive setting (news content trips them easily).
    safetySettings: [
      'HARM_CATEGORY_HARASSMENT',
      'HARM_CATEGORY_HATE_SPEECH',
      'HARM_CATEGORY_SEXUALLY_EXPLICIT',
      'HARM_CATEGORY_DANGEROUS_CONTENT',
    ].map((c) => ({ category: c, threshold: 'BLOCK_ONLY_HIGH' })),
  };

  const url = `${API_BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const resText = await fetchWithRetry(url, body, timeoutMs);
  const parsed = JSON.parse(resText);

  // Error diagnostics.
  if (parsed.error) {
    throw new Error(`Gemini API error: ${parsed.error.message || JSON.stringify(parsed.error)}`);
  }

  const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    const finish = parsed?.candidates?.[0]?.finishReason;
    throw new Error(`Gemini returned no text (finishReason=${finish ?? 'unknown'})`);
  }

  let intro;
  try {
    const obj = JSON.parse(text);
    intro = (obj.intro || '').trim();
  } catch {
    // Model occasionally misbehaves; fall back to plain text.
    intro = text.trim();
  }
  if (!intro) throw new Error('Gemini returned empty intro');

  return { intro, model };
}

function buildPrompt({ keyword, geo, geoName, lang, news = [] }) {
  const langLabel = LANG_LABEL[lang] ?? lang ?? 'English';
  // Use the full country/region name (e.g. Germany) instead of the ISO code (DE)
  // so the model doesn't misread DE as Delaware.
  const region = geoName || geo;
  const newsBlock = news.length
    ? news
        .slice(0, 8)
        .map((n, i) => {
          const src = (n.sources && n.sources.join(', ')) || '(unknown)';
          return `  ${i + 1}. ${n.title}  — ${src}`;
        })
        .join('\n')
    : '  (no related news headlines available)';

  // Writing guidelines:
  // - Describe the specific event from the news headlines; don't analyze "why it's hot"
  //   (AI reasoning about growth tends to produce boilerplate).
  // - Headlines are the source of truth; forbid "details are limited" filler.
  // - Model knowledge is only for "what is the keyword"; current state comes from news.
  return `You are writing a brief background summary for a trending search term.

TERM: "${keyword}"
REGION: ${region}
WRITE IN: ${langLabel}

RECENT NEWS HEADLINES about this term:
${newsBlock}

TASK:
Write a concise 3-4 sentence summary IN ${langLabel}. The summary should:
  1. Briefly say what/who "${keyword}" is (1 sentence, using general knowledge).
  2. Describe the SPECIFIC recent event happening now, based on the headlines above (1-2 sentences). Include concrete details from the headlines — names of teams, people, scores, outcomes, or what the news is actually about.
  3. Add one sentence of relevant context.

RULES:
- Output ONLY valid JSON: {"intro": "..."}.
- Write natural, reader-friendly prose. No lists, no markdown, no quotes around the term.
- The headlines above ARE the facts. Never write "details are limited" or "the reason is unclear" — instead, describe what the headlines say. If they mention a match, a result, a person, an announcement, say so specifically.
- Do not rely on outdated knowledge about the subject's current club/team/status if the headlines indicate otherwise.
- Do not cite sources or URLs. Do not repeat headlines verbatim — rephrase into flowing prose.
- Keep total length under 120 words.`;
}

async function fetchWithRetry(url, body, timeoutMs) {
  const maxAttempts = 3;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await rateLimit();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      if (res.ok) return text;

      // Retry 429 / 5xx; throw on other 4xx.
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
        // Wait longer on 429 to let the RPM window drain.
        await sleep(res.status === 429 ? 15000 : backoff(attempt));
        continue;
      }
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
    } catch (err) {
      lastErr = err;
      if (err.name === 'AbortError') {
        lastErr = new Error(`Gemini request timed out after ${timeoutMs}ms`);
      }
      if (attempt < maxAttempts) await sleep(backoff(attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr ?? new Error('Unknown Gemini failure');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 2s, 5s, ... (with light jitter)
const backoff = (attempt) => (attempt === 1 ? 2000 : 5000) + Math.floor(Math.random() * 500);
