// Gemini API client (zero dependencies).
//
// 使用 REST API (`generateContent`)，要求 JSON 输出以减少解析错误。
// 模型默认 gemini-2.5-flash（免费额度最宽松）。
//
// API key 来源（按优先级）：
//   1) 参数 opts.apiKey
//   2) env GEMINI_API_KEY
//   3) ./gemini-key 文件内容（方便本地开发）
import { readFile } from 'node:fs/promises';

const DEFAULT_MODEL = 'gemini-2.5-flash';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// Language label 用在 prompt 里告诉模型用哪种语言回答。
// 比 ISO code 更稳定。
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

// RPM rate limiter：确保两次请求之间至少隔 MIN_INTERVAL_MS。
// 付费档 flash 的 RPM 上限 1000（~16 RPS），我们用 150ms 间隔 ≈ 400 RPM，
// 留充足余量不撞限流。可通过 GEMINI_MIN_INTERVAL_MS 环境变量覆盖。
const MIN_INTERVAL_MS = Number(process.env.GEMINI_MIN_INTERVAL_MS) || 150;
let lastRequestAt = 0;
let gate = Promise.resolve();
async function rateLimit() {
  // 串行化闸门：并发调用者排队通过
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
 * 为一个关键词生成 3-4 句简介。
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
      // 强制 JSON，便于解析
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: {
          intro: { type: 'string' },
        },
        required: ['intro'],
      },
    },
    // 关闭安全过滤到最宽松（新闻类容易撞车）
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

  // 错误排查
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
    // 模型偶尔不守规矩，退化为文本
    intro = text.trim();
  }
  if (!intro) throw new Error('Gemini returned empty intro');

  return { intro, model };
}

function buildPrompt({ keyword, geo, lang, news = [] }) {
  const langLabel = LANG_LABEL[lang] ?? lang ?? 'English';
  const newsBlock = news.length
    ? news
        .slice(0, 8)
        .map((n, i) => {
          const src = (n.sources && n.sources.join(', ')) || '(unknown)';
          return `  ${i + 1}. ${n.title}  — ${src}`;
        })
        .join('\n')
    : '  (no related news headlines available)';

  // 写法要点：
  // - 明确"为什么现在热" = 当前事件
  // - 要求 3-4 句（不是 bullet）
  // - 要求同一种语言
  // - 新闻只是线索，允许模型用自身知识补充
  // - 不确定时明确说"据相关新闻"，避免幻觉
  return `You are writing a brief background summary for a trending search term.

TERM: "${keyword}"
REGION: ${geo}
WRITE IN: ${langLabel}

RECENT NEWS HEADLINES about this term (use them as clues for "why is this trending right now"):
${newsBlock}

TASK:
Write a concise 3-4 sentence summary IN ${langLabel}. The summary should:
  1. Briefly say what/who "${keyword}" is (1 sentence).
  2. Explain briefly why it is trending *right now*, based on the headlines above (1-2 sentences).
  3. Add one sentence of relevant context or background a reader would find useful.

RULES:
- Output ONLY valid JSON: {"intro": "..."}.
- Write natural, reader-friendly prose. No lists, no markdown, no quotes around the term.
- If the headlines are inconclusive or missing, say so gracefully (e.g., "Details about the current spike are limited.") instead of inventing specifics.
- Do not cite sources or URLs. Do not repeat the news headlines verbatim.
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

      // 429 / 5xx 重试；4xx 其它直接抛
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
        // 429 时等更久，给 RPM 窗口清空
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
// 2s, 5s, ...（轻度抖动）
const backoff = (attempt) => (attempt === 1 ? 2000 : 5000) + Math.floor(Math.random() * 500);
