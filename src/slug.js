// Keyword <-> filename slug.
// By default we generate filenames with simple rules to preserve readability
// (English/numeric keywords are recognizable at a glance).
// For non-Latin scripts (CJK/Thai/Arabic, etc.) the encoded form may exceed the filesystem's
// 255-byte filename limit; in that case we fall back to a hash: `kw-<sha1[0:16]>`.
//
// Since the fallback is not a reversible pure encoding, keyword -> slug is no longer guaranteed
// to be fully reversible. However, generation and reverse-lookup use the same function, so as
// long as both ends agree it's fine.
//
// Compatible with both Node.js and Cloudflare Workers runtimes.

// macOS/ext4 filename limit is 255 bytes; with ".html" and a small safety margin -> 220.
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

