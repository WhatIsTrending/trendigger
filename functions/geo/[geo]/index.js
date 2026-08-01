// Dynamic Latest page for /geo/{geo}/ — always queries the live D1 so the
// date nav reflects every date in the archive, not just those present at
// static-build time.  Functions take precedence over static assets in
// Cloudflare Pages, so this overrides public/geo/{geo}/index.html.
import { geoPage } from '../../_lib/templates.js';
import { GEOS } from '../../_lib/geos.js';

// 某个 keyword 当天 volume 峰值快照
const PEAK_SQL = `
SELECT t.date, t.geo, t.keyword, t.search_volume_num, t.search_volume_raw,
       t.started_at, t.picture, t.news_json, t.trend_breakdown_json,
       i.intro AS intro, i.intro_en AS intro_en
  FROM (
    SELECT s.date, s.geo, s.query AS keyword,
           s.search_volume AS search_volume_num,
           s.search_volume_label AS search_volume_raw,
           CAST(strftime('%s', s.started_at) AS INTEGER) AS started_at,
           s.picture, s.news_json, s.trend_breakdown_json,
           ROW_NUMBER() OVER (
             PARTITION BY s.geo, s.date, s.query
             ORDER BY s.search_volume DESC, s.observed_at DESC
           ) AS rn
      FROM trend_snapshots s
     WHERE s.geo = ? AND s.date = ?
  ) t
  LEFT JOIN keyword_intro i
    ON i.keyword = t.keyword AND i.geo = t.geo
 WHERE t.rn = 1
 ORDER BY t.search_volume_num DESC, t.keyword ASC`;

// 根据渲染语言挑 intro：英文视图优先 intro_en，回退 intro；否则用 intro
function pickIntro(row, lang) {
  if (lang === 'en') return row.intro_en || row.intro || null;
  return row.intro || null;
}

export async function onRequestGet({ params, env, request }) {
  const { geo } = params;

  // WW 无独立数据（首页 / 已是全球聚合视图），重定向到首页。
  if (geo === 'WW') {
    return Response.redirect(new URL('/', request.url).toString(), 301);
  }

  // Redirect /geo/XX to /geo/XX/ so that relative links (e.g.
  // "2026-07-24.html") resolve correctly.  Without the trailing slash the
  // browser treats "XX" as a file name and resolves relative URLs against
  // /geo/ instead of /geo/XX/.
  const url = new URL(request.url);
  const lastSegment = url.pathname.split('/').pop();
  if (!url.pathname.endsWith('/') && !lastSegment.includes('.')) {
    url.pathname += '/';
    return Response.redirect(url.toString(), 301);
  }

  const geoMeta = GEOS.find((g) => g.code === geo);
  if (!geoMeta) {
    return new Response('Region not found', { status: 404 });
  }

  // ?lang=en 切到英文变体；en 系 geo 本身即英文，无差别
  const lang = new URL(request.url).searchParams.get('lang') === 'en'
    ? 'en'
    : geoMeta.lang;

  try {
    const availableDates = await env.DB.prepare(
      `SELECT DISTINCT date FROM trend_snapshots WHERE geo = ? ORDER BY date DESC`,
    ).bind(geo).all();
    const dates = (availableDates.results || []).map((r) => r.date);

    if (!dates.length) {
      return new Response('No data available yet.', { status: 404 });
    }

    const latestDate = dates[0];

    const trends = await env.DB.prepare(PEAK_SQL).bind(geo, latestDate).all();

    // Re-rank sequentially (1..N) by search volume so the hottest topics come
    // first.
    const reranked = (trends.results || []).map((t, i) => ({
      ...t,
      rank: i + 1,
      intro: pickIntro(t, lang),
    }));

    const html = geoPage({
      geoMeta,
      date: latestDate,
      isLatest: true,
      trends: reranked,
      availableDates: dates,
      lang,
    });

    return new Response(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 's-maxage=3600, stale-while-revalidate=86400',
      },
    });
  } catch (e) {
    console.error('Error rendering latest geo page:', e);
    return new Response('Internal server error', { status: 500 });
  }
}
