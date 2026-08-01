import { geoPage } from '../../_lib/templates.js';
import { GEOS } from '../../_lib/geos.js';

// 某 geo 某 date 的峰值快照（每个 keyword 当天 volume 最高那条）
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

// WW 聚合：某 date 下所有可抓取 geo（排除 WW 自身）的峰值快照
const WW_PEAK_SQL = `
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
     WHERE s.date = ? AND s.geo != 'WW'
  ) t
  LEFT JOIN keyword_intro i
    ON i.keyword = t.keyword AND i.geo = t.geo
 WHERE t.rn = 1
 ORDER BY t.search_volume_num DESC`;

// 根据渲染语言挑 intro：英文视图优先 intro_en，回退 intro；否则用 intro
function pickIntro(row, lang) {
  if (lang === 'en') return row.intro_en || row.intro || null;
  return row.intro || null;
}

export async function onRequestGet({ params, env, request }) {
  let { geo, date } = params;

  if (!geo || !date) {
    return new Response('Bad request', { status: 400 });
  }

  if (date.endsWith('.html')) {
    date = date.slice(0, -5);
  }

  // /geo/XX/index.html is routed here with date="index" because [date].html.js
  // takes precedence over index.js for *.html paths.  Redirect to /geo/XX/.
  if (date === 'index') {
    const url = new URL(request.url);
    url.pathname = `/geo/${geo}/`;
    return Response.redirect(url.toString(), 301);
  }

  const geoMeta = GEOS.find((g) => g.code === geo);
  if (!geoMeta) {
    return new Response('Region not found', { status: 404 });
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return new Response('Invalid date format', { status: 400 });
  }

  // WW 始终英文视图；其余 geo 允许 ?lang=en 切到英文变体
  const lang = (geo === 'WW' || new URL(request.url).searchParams.get('lang') === 'en')
    ? 'en'
    : geoMeta.lang;

  try {
    // WW 没有自己的快照，在线聚合所有 geo 该日期的峰值
    if (geo === 'WW') {
      return await renderWwDatePage(env, geoMeta, date);
    }

    const trends = await env.DB.prepare(PEAK_SQL).bind(geo, date).all();

    const availableDates = await env.DB.prepare(
      `SELECT DISTINCT date FROM trend_snapshots WHERE geo = ? ORDER BY date DESC`,
    ).bind(geo).all();

    // Re-rank sequentially (1..N) by search volume so the hottest topics come first.
    const reranked = (trends.results || []).map((t, i) => ({
      ...t,
      rank: i + 1,
      intro: pickIntro(t, lang),
    }));

    const html = geoPage({
      geoMeta,
      date,
      isLatest: false,
      trends: reranked,
      availableDates: (availableDates.results || []).map((r) => r.date),
      lang,
    });

    return new Response(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 's-maxage=3600, stale-while-revalidate=86400',
      },
    });
  } catch (e) {
    console.error('Error rendering date page:', e);
    return new Response('Internal server error', { status: 500 });
  }
}

// WW 历史日期页：聚合所有 geo 该日期峰值，跨 geo 按关键词去重（取 volume 最高），
// 按搜索量降序取 TOP 100，复用 geoPage 模板渲染（showGeoFlag=true 已内置）。
// WW 一律使用英文 summary（intro_en，回退 intro），keyword 仍保留原始语言。
async function renderWwDatePage(env, geoMeta, date) {
  const rows = await env.DB.prepare(WW_PEAK_SQL).bind(date).all();
  const items = rows.results || [];

  // 跨 geo 按 normalized keyword 去重，保留 volume 最高那条
  const byKey = new Map();
  for (const it of items) {
    const key = (it.keyword || '').toString().toLowerCase().trim();
    if (!key) continue;
    const prev = byKey.get(key);
    if (!prev || (it.search_volume_num ?? 0) > (prev.search_volume_num ?? 0)) {
      byKey.set(key, it);
    }
  }
  const ranked = [...byKey.values()]
    .sort((a, b) => (b.search_volume_num ?? 0) - (a.search_volume_num ?? 0))
    .slice(0, 100)
    .map((it, i) => ({ ...it, rank: i + 1, intro: pickIntro(it, 'en') }));

  // WW 可用日期 = 所有 geo 日期并集
  const datesRes = await env.DB.prepare(
    `SELECT DISTINCT date FROM trend_snapshots ORDER BY date DESC`,
  ).all();
  const availableDates = (datesRes.results || []).map((r) => r.date);

  const html = geoPage({
    geoMeta,
    date,
    isLatest: false,
    trends: ranked,
    availableDates,
    lang: 'en',
  });

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 's-maxage=3600, stale-while-revalidate=86400',
    },
  });
}
