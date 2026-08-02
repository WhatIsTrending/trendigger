// Fetch a news article and extract a short snippet.
// Priority: og:description > <meta name="description"> > first <p> in <article> > first <p> anywhere.
// Avoids heavy deps like readability/cheerio to keep the demo small.
//
// Note: this is a demo-stage shortcut. In production we use Gemini to generate intros from the
// title set; full article body is a nice-to-have and skipped when unnecessary.

const DEFAULT_TIMEOUT_MS = 6000;
const MAX_HTML_BYTES = 300_000;        // truncate at 300 KB to avoid huge pages
const MAX_SNIPPET_LEN = 280;

/**
 * @param {string} url
 * @param {{ timeoutMs?: number, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<string|null>}
 */
export async function fetchArticleSnippet(url, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('html')) return null;

    // Read only the first N bytes to avoid huge responses.
    const reader = res.body?.getReader();
    if (!reader) return null;
    const chunks = [];
    let received = 0;
    while (received < MAX_HTML_BYTES) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
    }
    try { await reader.cancel(); } catch {}
    const html = new TextDecoder('utf-8', { fatal: false }).decode(
      concatChunks(chunks, received),
    );

    return extractSnippet(html);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function concatChunks(chunks, total) {
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** Exported for testing. */
export function extractSnippet(html) {
  const og = matchMeta(html, /property=["']og:description["']/i);
  if (og) return clip(og);

  const desc = matchMeta(html, /name=["']description["']/i);
  if (desc) return clip(desc);

  // <article>...<p>first paragraph</p>
  const articleMatch = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
  if (articleMatch) {
    const p = firstParagraph(articleMatch[1]);
    if (p) return clip(p);
  }

  const p = firstParagraph(html);
  if (p) return clip(p);

  return null;
}

// Match <meta ... content="..."> in HTML; attributeMatcher matches the name/property attribute.
function matchMeta(html, attributeMatcher) {
  const metaRe = /<meta\b([^>]*)>/gi;
  let m;
  while ((m = metaRe.exec(html))) {
    const attrs = m[1];
    if (!attributeMatcher.test(attrs)) continue;
    const c = attrs.match(/content=["']([^"']*)["']/i);
    if (c?.[1]) return decodeEntities(c[1]).trim();
  }
  return null;
}

function firstParagraph(html) {
  const re = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(html))) {
    const text = stripTags(m[1]).trim();
    if (text.length >= 60) return text; // skip short paragraphs (nav, copyright, etc.)
  }
  return null;
}

function stripTags(s) {
  return decodeEntities(s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function clip(s) {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= MAX_SNIPPET_LEN) return t;
  return t.slice(0, MAX_SNIPPET_LEN - 1).trimEnd() + '…';
}
