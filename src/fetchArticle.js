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
    const bytes = concatChunks(chunks, received);

    // Detect charset: HTTP Content-Type header first, then <meta charset> in
    // the first 4KB of the body. Many Japanese news sites (oricon, daily.co.jp,
    // etc.) still serve Shift-JIS; force-decoding as UTF-8 turns the bytes into
    // U+FFFD replacement chars and the stored intro becomes irreversible mojibake.
    const encoding = detectEncoding(ct, bytes) || 'utf-8';
    const html = new TextDecoder(encoding, { fatal: false }).decode(bytes);

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

// Map of common charset aliases to the labels accepted by TextDecoder.
// Covers the encodings most often seen on Asian news sites (Shift-JIS,
// EUC-JP, ISO-2022-JP, GBK, Big5, EUC-KR) plus the UTF family.
const CHARSET_ALIASES = {
  'shift_jis': 'shift-jis',
  'shift-jis': 'shift-jis',
  'sjis': 'shift-jis',
  'x-sjis': 'shift-jis',
  'ms_kanji': 'shift-jis',
  'csshiftjis': 'shift-jis',
  'windows-31j': 'shift-jis',
  'x-ms-cp932': 'shift-jis',
  'cp932': 'shift-jis',
  'euc-jp': 'euc-jp',
  'euc_jp': 'euc-jp',
  'x-euc-jp': 'euc-jp',
  'iso-2022-jp': 'iso-2022-jp',
  'iso2022-jp': 'iso-2022-jp',
  'euc-kr': 'euc-kr',
  'euc_kr': 'euc-kr',
  'ks_c_5601-1987': 'euc-kr',
  'ks_c_5601': 'euc-kr',
  'windows-949': 'euc-kr',
  'gbk': 'gbk',
  'gb2312': 'gbk',
  'csgb2312': 'gbk',
  'gb18030': 'gb18030',
  'big5': 'big5',
  'big5-hkscs': 'big5',
  'csbig5': 'big5',
  'utf-8': 'utf-8',
  'utf8': 'utf-8',
  'us-ascii': 'utf-8',
  'ascii': 'utf-8',
  'iso-8859-1': 'utf-8', // safe fallback: many sites declare latin1 but serve UTF-8
};

function normalizeCharset(raw) {
  if (!raw) return null;
  const key = raw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return CHARSET_ALIASES[key] || null;
}

/**
 * Detect the response encoding. Priority:
 *   1) charset parameter in the Content-Type header
 *   2) <meta charset="..."> / <meta http-equiv="Content-Type" content="...; charset=...">
 *      in the first 4KB of the body (decoded as ASCII to find the tag)
 * Returns a TextDecoder-compatible label (e.g. 'shift-jis', 'utf-8') or null
 * if nothing was found.
 */
function detectEncoding(contentType, bytes) {
  // 1) HTTP header
  const headerMatch = /charset\s*=\s*["']?([^\s;"']+)/i.exec(contentType || '');
  if (headerMatch) {
    const enc = normalizeCharset(headerMatch[1]);
    if (enc) return enc;
  }

  // 2) <meta charset> in the first 4KB. Meta tags live in <head>, which is
  // always ASCII regardless of the body encoding, so decoding as ASCII is safe.
  const headLen = Math.min(bytes.length, 4096);
  let head = '';
  for (let i = 0; i < headLen; i++) head += String.fromCharCode(bytes[i]);
  // <meta charset="shift_jis">  or  <meta http-equiv="Content-Type" content="...; charset=shift_jis">
  const metaCharset = /<meta[^>]*charset\s*=\s*["']?([^\s;"'>]+)/i.exec(head);
  if (metaCharset) {
    const enc = normalizeCharset(metaCharset[1]);
    if (enc) return enc;
  }
  return null;
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
