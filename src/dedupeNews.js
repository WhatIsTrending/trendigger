// 新闻去重：
// 1) 规范化标题完全相同 -> 合并 sources（保留第一条的 url/picture）
// 2) 标题高度相似（Jaccard >= THRESHOLD）-> 视为同一条，保留先出现的
//
// 设计上是纯函数，便于后续在 Stage 2 写入 D1 前调用。

const SIMILARITY_THRESHOLD = 0.8;

/** @param {import('./fetchTrends.js').TrendNews[]} news */
export function dedupeNews(news) {
  const result = [];

  for (const n of news) {
    const norm = normalizeTitle(n.title);
    if (!norm) continue;

    // Pass 1: 完全相同
    const exact = result.find((r) => r._norm === norm);
    if (exact) {
      mergeSources(exact, n);
      continue;
    }

    // Pass 2: 高相似度
    const tokens = tokenize(norm);
    const similar = result.find(
      (r) => jaccard(tokens, r._tokens) >= SIMILARITY_THRESHOLD,
    );
    if (similar) {
      // 选更长的标题保留（信息更全），合并来源。
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

  // 去掉内部辅助字段
  return result.map(({ _norm, _tokens, source, ...keep }) => keep);
}

// 让 dedupeNews 幂等：既能处理原始 {source} 形态，也能处理已去过重的 {sources} 形态。
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
    .replace(/[\u2018\u2019\u201C\u201D]/g, "'") // 智能引号 -> 直引号
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')          // 去标点（保留 Unicode 字母数字）
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(normTitle) {
  // 对 CJK 也合理：标点已被剥掉，按 Unicode "字" 切分。
  // 英文按空格分词；CJK 因为字间无空格，做 2-gram 提升相似度判断质量。
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
