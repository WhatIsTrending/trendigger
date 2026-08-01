// Keyword <-> filename slug.
// 默认用简单规则生成文件名——保留可读性（英文/数字关键词一眼可认）。
// 对 CJK/Thai/Arabic 等非拉丁语言，编码后可能超过文件系统 255-byte 文件名上限，
// 此时 fallback 为哈希：`kw-<sha1[0:16]>`。
//
// 由于 fallback 不是可逆的纯编码，我们不再保证 keyword -> slug 之间完全可逆；
// 但我们生成和反查都用同一个函数，只要两端一致就 OK。
//
// 兼容 Node.js 和 Cloudflare Workers 运行时。

// macOS/ext4 文件名上限 255 字节；再加上 ".html" 和少许安全余量 → 220。
const MAX_SLUG_BYTES = 220;

function createSimpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h) + str.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h).toString(16).padStart(8, '0');
}

const encoder = new TextEncoder();

export function keywordToSlug(keyword) {
  let slug = keyword
    .toLowerCase()
    .replace(/[^a-z0-9\u0080-\uffff\s-]/g, '')
    .replace(/\s+/g, '-');
  if (encoder.encode(slug).length <= MAX_SLUG_BYTES) {
    return slug;
  }
  return `kw-${createSimpleHash(keyword)}`;
}

export function slugToKeyword(slug) {
  if (slug.startsWith('kw-')) return slug;
  return slug.replace(/-/g, ' ');
}

export function keywordHref(keyword) {
  return `keyword/${keywordToSlug(keyword)}.html`;
}

