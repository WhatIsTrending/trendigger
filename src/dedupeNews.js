// News deduplication:
// 1) Identical normalized titles -> merge sources (keep first url/picture)
// 2) Highly similar titles (Jaccard >= THRESHOLD) -> treat as the same item, keep the first
//
// Designed as a pure function so it can be invoked before Stage 2 writes to D1.

const SIMILARITY_THRESHOLD = 0.8;

/** @param {import('./fetchTrends.js').TrendNews[]} news */
export function dedupeNews(news) {
  const result = [];

  for (const n of news) {
    const norm = normalizeTitle(n.title);
    if (!norm) continue;

    // Pass 1: exact match
    const exact = result.find((r) => r._norm === norm);
    if (exact) {
      mergeSources(exact, n);
      continue;
    }

    // Pass 2: high similarity
    const tokens = tokenize(norm);
    const similar = result.find(
      (r) => jaccard(tokens, r._tokens) >= SIMILARITY_THRESHOLD,
    );
    if (similar) {
      // Keep the longer title (more complete) and merge sources.
      if (n.title.length > similar.title.length) {
        similar.title = n.title;
        similar.url = n.url;
        similar.picture = n.picture;
        similar._norm = norm;
        similar._tokens = tokens;
      }
      mergeSources(similar, n);
      continue;
    }

    result.push({
      ...n,
      sources: buildInitialSources(n),
      _norm: norm,
      _tokens: tokens,
    });
  }

  // Strip internal helper fields
  return result.map(({ _norm, _tokens, source, ...keep }) => keep);
}

// Make dedupeNews idempotent: it accepts both the raw {source} shape and the already-deduped {sources} shape.
function buildInitialSources(n) {
  if (Array.isArray(n.sources)) return [...n.sources];
  return n.source ? [n.source] : [];
}

function mergeSources(item, incoming) {
  const toAdd = Array.isArray(incoming.sources)
    ? incoming.sources
    : incoming.source
      ? [incoming.source]
      : [];
  for (const s of toAdd) {
    if (s && !item.sources.includes(s)) item.sources.push(s);
  }
}

function normalizeTitle(title) {
  return (title || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u2018\u2019\u201C\u201D]/g, "'") // smart quotes -> straight quotes
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')          // strip punctuation (keep Unicode letters/numbers)
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(normTitle) {
  // Reasonable for CJK too: punctuation has been stripped, split by Unicode "characters".
  // English is split on whitespace; CJK has no inter-word spaces, so use 2-grams to improve
  // similarity quality.
  const ascii = /^[\x00-\x7f\s]+$/.test(normTitle);
  if (ascii) {
    return new Set(normTitle.split(' ').filter((t) => t.length > 1));
  }
  const grams = new Set();
  const compact = normTitle.replace(/\s+/g, '');
  for (let i = 0; i < compact.length - 1; i++) {
    grams.add(compact.slice(i, i + 2));
  }
  return grams;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return inter / union;
}
