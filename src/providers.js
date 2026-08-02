import { generateIntro as geminiGenerateIntro } from './gemini.js';
import { fetchArticleSnippet } from './fetchArticle.js';

const PROVIDER = process.env.AI_PROVIDER || 'gemini';
const FALLBACK_PROVIDER = process.env.FALLBACK_PROVIDER || '';

// Circuit breaker: Cloudflare free Workers AI has a 10k daily neuron cap.
// Once we hit a quota-exhausted 429, skip all remaining cloudflare calls this run,
// so 8-way concurrency doesn't retry 3×15s per keyword and blow the 30min CI budget.
let cloudflareQuotaExhausted = false;

function looksLikeCfQuotaError(status, body) {
  if (status !== 429) return false;
  const msg = String(body || '').toLowerCase();
  return msg.includes('neuron') || msg.includes('daily free allocation');
}

export async function generateIntro(input, opts = {}) {
  const primary = PROVIDER.toLowerCase();
  const fallback = FALLBACK_PROVIDER.toLowerCase();

  try {
    return await executeProvider(primary, input, opts);
  } catch (err) {
    if (fallback) {
      console.log(`  [${primary} failed, fallback to ${fallback}]: ${input.keyword}`);
      try {
        return await executeProvider(fallback, input, opts);
      } catch (fbErr) {
        throw new Error(`${primary}: ${err.message} | ${fallback}: ${fbErr.message}`);
      }
    }
    throw err;
  }
}

async function executeProvider(provider, input, opts) {
  switch (provider) {
    case 'gemini':
      return geminiGenerateIntro(input, opts);
    case 'cloudflare':
      return cloudflareGenerateIntro(input, opts);
    case 'snippet':
      return snippetGenerateIntro(input, opts);
    case 'none':
      throw new Error('AI_PROVIDER=none: enrich is disabled');
    default:
      throw new Error(`Unknown AI provider: ${provider}. Use 'gemini', 'cloudflare', 'snippet', or 'none'.`);
  }
}

const CF_API_BASE = 'https://api.cloudflare.com/client/v4/accounts';
const CF_DEFAULT_MODEL = '@cf/meta/llama-3.1-8b-instruct';

async function cloudflareGenerateIntro(input, opts = {}) {
  if (cloudflareQuotaExhausted) {
    throw new Error('Cloudflare AI daily neuron quota exhausted (circuit breaker open)');
  }
  const model = opts.model ?? CF_DEFAULT_MODEL;
  const accountId = await loadCfAccountId();
  const apiToken = await loadCfApiToken();
  const timeoutMs = opts.timeoutMs ?? 30_000;

  const prompt = buildPrompt(input);
  const body = {
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
    max_tokens: 256,
  };

  const url = `${CF_API_BASE}/${encodeURIComponent(accountId)}/ai/run/${model}`;

  const resText = await cfFetchWithRetry(url, body, apiToken, timeoutMs);
  const parsed = JSON.parse(resText);

  if (parsed.errors && parsed.errors.length > 0) {
    throw new Error(`Cloudflare AI error: ${JSON.stringify(parsed.errors)}`);
  }

  let text = parsed?.result?.response ?? parsed?.result?.choices?.[0]?.message?.content ?? parsed?.result?.content ?? '';
  if (!text) {
    throw new Error('Cloudflare AI returned empty response');
  }

  let intro;
  if (typeof text === 'object') {
    intro = (text.intro || '').trim();
  } else if (typeof text === 'string') {
    try {
      const obj = JSON.parse(text);
      intro = (obj.intro || '').trim();
    } catch {
      intro = text.trim();
    }
  } else {
    intro = String(text).trim();
  }
  if (!intro) throw new Error('Cloudflare AI returned empty intro');

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
  sq: 'Albanian', pt: 'Portuguese', hy: 'Armenian', az: 'Azerbaijani',
  bn: 'Bengali', be: 'Belarusian', nl: 'Dutch', bs: 'Bosnian', bg: 'Bulgarian',
  km: 'Khmer', hr: 'Croatian', cs: 'Czech', da: 'Danish', et: 'Estonian',
  am: 'Amharic', fi: 'Finnish', el: 'Greek', ka: 'Georgian', hu: 'Hungarian',
  fa: 'Persian', he: 'Hebrew', it: 'Italian', kk: 'Kazakh', ky: 'Kyrgyz',
  lv: 'Latvian', lt: 'Lithuanian', pl: 'Polish', ro: 'Romanian', no: 'Norwegian',
  ur: 'Urdu', sk: 'Slovak', sl: 'Slovenian', sv: 'Swedish', sr: 'Serbian',
  'zh-TW': 'Traditional Chinese (Taiwan)', tk: 'Turkmen', uk: 'Ukrainian',
};

async function loadCfAccountId() {
  if (process.env.CLOUDFLARE_ACCOUNT_ID) {
    return process.env.CLOUDFLARE_ACCOUNT_ID;
  }
  throw new Error('Cloudflare AI requires CLOUDFLARE_ACCOUNT_ID env var');
}

async function loadCfApiToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) {
    return process.env.CLOUDFLARE_API_TOKEN;
  }
  throw new Error('Cloudflare AI requires CLOUDFLARE_API_TOKEN env var');
}

async function cfFetchWithRetry(url, body, apiToken, timeoutMs) {
  const maxAttempts = 3;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiToken}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      if (res.ok) return text;

      if (res.status === 401) {
        throw new Error(
          `Cloudflare AI 401: Authentication failed. ` +
          `Your CLOUDFLARE_API_TOKEN may lack AI permissions. ` +
          `In Cloudflare Dashboard, create/update an API token with Account > AI > Edit permissions. ` +
          `Response: ${text.slice(0, 300)}`
        );
      }

      if (looksLikeCfQuotaError(res.status, text)) {
        cloudflareQuotaExhausted = true;
        console.warn(
          '  ⚠ Cloudflare AI daily neuron quota exhausted — ' +
          'disabling cloudflare for the rest of this run.',
        );
        throw new Error('Cloudflare AI daily neuron quota exhausted');
      }
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
        await sleep(res.status === 429 ? 15000 : backoff(attempt));
        continue;
      }
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
    } catch (err) {
      lastErr = err;
      if (err.name === 'AbortError') {
        lastErr = new Error(`Cloudflare AI request timed out after ${timeoutMs}ms`);
      }
      if (attempt < maxAttempts) await sleep(backoff(attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr ?? new Error('Unknown Cloudflare AI failure');
}

// Filler lead prefixes (case-sensitive): snippets starting with these are
// low-info news-live boilerplate; fall back to the news title instead.
const FILLER_PREFIXES = ['Follow ', 'Sigue ', 'Siga ', 'Segu', 'Live:', 'Watch ', 'Ver '];
function isFillerLead(text) {
  return FILLER_PREFIXES.some((p) => text.startsWith(p));
}

async function snippetGenerateIntro(input, opts = {}) {
  const { keyword, news = [] } = input;
  const timeoutMs = opts.timeoutMs ?? 6000;

  for (const item of news.slice(0, 3)) {
    if (item.snippet && item.snippet.trim()) {
      const snip = item.snippet.trim();
      if (!isFillerLead(snip)) {
        return { intro: snip, model: 'snippet-rss' };
      }
      // Snippet is filler; try the next item.
    }

    if (item.url) {
      try {
        const snippet = await fetchArticleSnippet(item.url, { timeoutMs });
        if (snippet && snippet.trim() && !isFillerLead(snippet.trim())) {
          return { intro: snippet.trim(), model: 'snippet-fetched' };
        }
      } catch {
        continue;
      }
    }
  }

  // All snippets are filler or unavailable → fall back to the longest news title.
  const titles = news
    .map((n) => n.title)
    .filter((t) => t && t.trim().length >= 20)
    .sort((a, b) => b.length - a.length);
  if (titles.length) {
    return { intro: titles[0].trim(), model: 'snippet-title' };
  }

  throw new Error(`No snippet available for "${keyword}"`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoff = (attempt) => (attempt === 1 ? 2000 : 5000) + Math.floor(Math.random() * 500);