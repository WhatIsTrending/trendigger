import { keywordPage } from '../../../_lib/templates.js';
import { GEOS } from '../../../_lib/geos.js';
import { keywordToSlug } from '../../../_lib/slug.js';

// 某 keyword 在某 geo 的历史：每个 date 取 volume 峰值快照
const HISTORY_SQL = `
SELECT t.date, t.geo, t.keyword, t.search_volume_num, t.search_volume_raw,
       t.started_at, t.picture, t.news_json, t.trend_breakdown_json, t.explore_url,
       i.intro AS intro, i.intro_en AS intro_en
  FROM (
    SELECT s.date, s.geo, s.query AS keyword,
           s.search_volume AS search_volume_num,
           s.search_volume_label AS search_volume_raw,
           CAST(strftime('%s', s.started_at) AS INTEGER) AS started_at,
           s.picture, s.news_json, s.trend_breakdown_json, s.explore_url,
           ROW_NUMBER() OVER (
             PARTITION BY s.date, s.query
             ORDER BY s.search_volume DESC, s.observed_at DESC
           ) AS rn
      FROM trend_snapshots s
     WHERE s.geo = ? AND s.query = ?
  ) t
  LEFT JOIN keyword_intro i
    ON i.keyword = t.keyword AND i.geo = t.geo
 WHERE t.rn = 1
 ORDER BY t.date DESC`;

// 根据渲染语言挑 intro：英文视图优先 intro_en，回退 intro；否则用 intro
function pickIntro(row, lang) {
  if (lang === 'en') return row.intro_en || row.intro || null;
  return row.intro || null;
}

export async function onRequestGet({ params, env, request }) {
  let { geo, slug } = params;

  if (!geo || !slug) {
    return new Response('Bad request', { status: 400 });
  }

  if (slug.endsWith('.html')) {
    slug = slug.slice(0, -5);
  }

  try {
    slug = decodeURIComponent(slug);
  } catch {
    // already decoded — use as-is
  }

  const geoMeta = GEOS.find((g) => g.code === geo);
  if (!geoMeta) {
    return new Response('Region not found', { status: 404 });
  }

  try {
    // Reverse-lookup: compute keywordToSlug() for every keyword in this geo
    // and find the one that matches the requested slug.  Necessary because
    // slugToKeyword() is lossy (lowercasing, hyphen→space) and fails for CJK,
    // mixed-case, and hyphenated keywords.
    const candidates = await env.DB.prepare(
      `SELECT DISTINCT query AS keyword FROM trend_snapshots WHERE geo = ?`,
    ).bind(geo).all();

    const keyword = (candidates.results || [])
      .find((k) => keywordToSlug(k.keyword) === slug)?.keyword;

    if (!keyword) {
      return new Response('Keyword not found', { status: 404 });
    }

    const history = await env.DB.prepare(HISTORY_SQL).bind(geo, keyword).all();

    if (!history.results || history.results.length === 0) {
      return new Response('Keyword not found', { status: 404 });
    }

    // ?lang=en 切到英文变体
    const lang = new URL(request.url).searchParams.get('lang') === 'en'
      ? 'en'
      : geoMeta.lang;

    const rows = history.results.map((r) => ({ ...r, intro: pickIntro(r, lang) }));
    const intro = rows.find((r) => r.intro)?.intro ?? null;

    const html = keywordPage({
      geoMeta,
      keyword,
      intro,
      history: rows,
      lang,
    });

    return new Response(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 's-maxage=3600, stale-while-revalidate=86400',
      },
    });
  } catch (e) {
    console.error('Error rendering keyword page:', e);
    return new Response('Internal server error', { status: 500 });
  }
}
