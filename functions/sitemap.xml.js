// Dynamic sitemap.xml — queries D1 for all geo + date pages.
import { GEOS } from './_lib/geos.js';

const BASE = 'https://trendigger.com';

// 当地语言非 en 的 geo：每个页面都有 ?lang=en 英文变体，需一并提交给搜索引擎。
const NON_EN_GEOS = new Set(GEOS.filter((g) => g.lang !== 'en').map((g) => g.code));

export async function onRequestGet({ env }) {
  const today = new Date().toISOString().slice(0, 10);

  // Static pages: home + each geo index. Updated every 4h, so 'hourly'.
  /** @type {string[]} */
  const urls = [];

  urls.push(urlEntry(`${BASE}/`, today, 'hourly', '1.0'));

  // WW 没有独立页面（首页 / 即全球聚合视图），跳过避免与 home 重复。
  for (const g of GEOS) {
    if (g.code === 'WW') continue;
    urls.push(urlEntry(`${BASE}/geo/${g.code}/`, today, 'hourly', '0.9'));
    // 非 en geo 的英文变体页
    if (NON_EN_GEOS.has(g.code)) {
      urls.push(urlEntry(`${BASE}/geo/${g.code}/?lang=en`, today, 'hourly', '0.8'));
    }
  }

  // Dynamic date pages from D1.
  try {
    const rows = await env.DB.prepare(
      `SELECT DISTINCT geo, date FROM trend_snapshots ORDER BY geo, date DESC`,
    ).all();

    for (const r of rows.results || []) {
      urls.push(urlEntry(
        `${BASE}/geo/${r.geo}/${r.date}.html`,
        r.date,
        'monthly',
        '0.6',
      ));
      // 非 en geo 的英文变体
      if (NON_EN_GEOS.has(r.geo)) {
        urls.push(urlEntry(
          `${BASE}/geo/${r.geo}/${r.date}.html?lang=en`,
          r.date,
          'monthly',
          '0.5',
        ));
      }
    }
  } catch {
    // If D1 is unavailable, still serve the static pages.
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>
`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 's-maxage=3600, stale-while-revalidate=86400',
    },
  });
}

function urlEntry(loc, lastmod, changefreq, priority) {
  return `  <url>
    <loc>${loc}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`;
}
