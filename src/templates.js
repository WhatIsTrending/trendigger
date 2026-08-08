// HTML templates — hand-written tagged-literal style.
// All user-controlled strings must go through escape().
import { GEOS, GEO_BY_CODE } from './geos.js';
import { keywordHref, keywordToSlug } from './slug.js';

// Site base URL for canonical / hreflang / share links
const SITE_BASE = 'https://trendigger.com';

// Native names of each locale (used for the language-switch button label)
const LANG_NATIVE = {
  en: 'English', ja: '日本語', ko: '한국어', de: 'Deutsch', fr: 'Français',
  es: 'Español', ru: 'Русский', 'pt-BR': 'Português', id: 'Bahasa Indonesia',
  th: 'ไทย', vi: 'Tiếng Việt', ms: 'Bahasa Melayu', 'zh-HK': '繁體中文',
  tr: 'Türkçe', ar: 'العربية',
  sq: 'Shqip', pt: 'Português', hy: 'Հայերեն', az: 'Azərbaycanca', bn: 'বাংলা',
  be: 'Беларуская', nl: 'Nederlands', bs: 'Bosanski', bg: 'Български', km: 'ខ្មែរ',
  hr: 'Hrvatski', cs: 'Čeština', da: 'Dansk', et: 'Eesti', am: 'አማርኛ', fi: 'Suomi',
  el: 'Ελληνικά', ka: 'ქართული', hu: 'Magyar', fa: 'فارسی', he: 'עברית',
  it: 'Italiano', kk: 'Қазақша', ky: 'Кыргызча', lv: 'Latviešu', lt: 'Lietuvių',
  pl: 'Polski', ro: 'Română', no: 'Norsk', ur: 'اردو', sk: 'Slovenčina',
  sl: 'Slovenščina', sv: 'Svenska', sr: 'Српски', 'zh-TW': '繁體中文', tk: 'Türkmen',
  uk: 'Українська',
};

// ---------------------------------------------------------------------------
// Escape helpers

export function escape(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escAttr(s) { return escape(s); }

// RTL languages
const RTL_LANGS = new Set(['ar', 'fa', 'he', 'ur']);

// Simple emoji flag: build regional indicator pair from ISO-2 country code
function flagEmoji(code) {
  if (code === 'WW') return '🌐';
  if (!code || code.length !== 2) return '🏳️';
  const A = 0x1F1E6;
  return String.fromCodePoint(
    A + (code.charCodeAt(0) - 65),
    A + (code.charCodeAt(1) - 65),
  );
}

// HTML-context flag: use flag-icons SVG (consistent cross-platform, including Windows).
// WW has no ISO flag, falls back to 🌐 emoji; unknown codes fall back to emoji flag.
// Note: <select><option> only accepts plain text, so flagEmoji() is still used there.
function flagHtml(code, title) {
  if (code === 'WW') return '<span class="fi-emoji">🌐</span>';
  if (!code || code.length !== 2) return '<span class="fi-emoji">🏳️</span>';
  const lc = code.toLowerCase();
  const t = title ? ` title="${escAttr(title)}"` : '';
  return `<span class="fi fi-${lc}"${t}></span>`;
}

function formatInt(n) {
  if (n == null || !Number.isFinite(n)) return 'n/a';
  if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1) + 'M+';
  if (n >= 1e3) return (n / 1e3).toFixed(n % 1e3 === 0 ? 0 : 1) + 'K+';
  return n + '+';
}

// "the walking dead" -> "#TheWalkingDead", "東野圭吾" -> "#東野圭吾"
function keywordHashtag(keyword) {
  const tag = String(keyword || '')
    .trim()
    .split(/\s+/)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('')
    .replace(/[^\p{L}\p{N}]/gu, '');
  return tag ? '#' + tag : '';
}

/**
 * Build social share text (mainly for X/Twitter intents).
 * @param {object} o
 * @param {string} o.keyword
 * @param {string|null} [o.intro]
 * @param {number} [o.peakVolume]   - detail-page peak search volume
 * @param {number} [o.daysTrending] - detail-page consecutive trending days
 * @param {string} [o.currentVolume] - card current-volume label
 * @returns {string}
 */
function buildShareText({ keyword, intro, peakVolume, daysTrending, currentVolume }) {
  const hashtag = keywordHashtag(keyword);
  const lines = [];
  lines.push(`${hashtag} is trending on Google`);

  const stats = [];
  if (peakVolume != null && peakVolume > 0) stats.push(`Peak: ${formatInt(peakVolume)}`);
  if (currentVolume) stats.push(`${currentVolume} searches`);
  if (daysTrending != null && daysTrending > 0) stats.push(`${daysTrending} day${daysTrending > 1 ? 's' : ''} trending`);
  if (stats.length) lines.push(stats.join(' | '));

  if (intro) {
    const maxLen = 150;
    lines.push(intro.length > maxLen ? intro.slice(0, maxLen).trimEnd() + '…' : intro);
  }

  return lines.join('\n\n');
}

/** Escape a string for safe embedding inside a JS single-quoted string literal (for onclick). */
function escapeJsString(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

/**
 * Whether this is an "English variant" page: true only when the geo's local
 * language is not en and the current render lang is 'en'.
 * English geos (US/IN/AU/...) and WW are already English, so no ?lang=en query param is needed.
 */
function isEnVariantPage(geoMeta, lang) {
  return !!geoMeta && geoMeta.lang !== 'en' && lang === 'en';
}

/**
 * Build the hreflang alternate list for a given basePath.
 * English geos / WW have no alternates (the page itself is English).
 */
function buildAlternates(geoMeta, basePath) {
  if (!basePath || !geoMeta || geoMeta.lang === 'en') return [];
  return [
    { hreflang: geoMeta.lang, path: basePath },
    { hreflang: 'en', path: `${basePath}?lang=en` },
    { hreflang: 'x-default', path: basePath },
  ];
}

/**
 * Language-switch nav: local language ↔ English. Not rendered for English geos.
 */
function buildLangSwitch(geoMeta, lang, basePath) {
  if (!basePath || !geoMeta || geoMeta.lang === 'en') return '';
  if (lang === 'en') {
    const label = LANG_NATIVE[geoMeta.lang] || geoMeta.lang;
    return `<nav class="lang-switch" aria-label="Language"><a href="${escAttr(basePath)}" rel="alternate" hreflang="${escAttr(geoMeta.lang)}">${escape(label)}</a></nav>`;
  }
  return `<nav class="lang-switch" aria-label="Language"><a href="${escAttr(basePath)}?lang=en" rel="alternate" hreflang="en">English</a></nav>`;
}

// ---------------------------------------------------------------------------
// Layout shell

/**
 * @param {object} o
 * @param {string} o.title
 * @param {string} [o.lang] - html lang attr
 * @param {string} o.bodyHtml
 * @param {string} [o.assetsPrefix] - relative path to assets root, e.g. "../../"
 * @param {string} [o.canonicalPath] - path for <link rel="canonical"> (no domain, may include ?lang=en)
 * @param {{hreflang:string,path:string}[]} [o.alternates] - hreflang alternate language versions
 * @param {string} [o.image] - absolute image URL for og:image / twitter:image
 */
export function layout({ title, lang = 'en', bodyHtml, assetsPrefix = '', canonicalPath, alternates = [], description, jsonLd, image } ) {
  const dir = RTL_LANGS.has(lang.split('-')[0]) ? 'rtl' : 'ltr';
  const canonicalUrl = canonicalPath ? SITE_BASE + canonicalPath : SITE_BASE + '/';
  const canonicalTag = `<link rel="canonical" href="${escAttr(canonicalUrl)}">`;
  const alternateTags = alternates
    .map((a) => `<link rel="alternate" hreflang="${escAttr(a.hreflang)}" href="${escAttr(SITE_BASE + a.path)}">`)
    .join('\n');
  // Dynamic meta description: falls back to a generic, keyword-rich default.
  const desc = description
    ? escape(description)
    : escape(`Discover the top Google Trends ${GEOS.length - 1}+ countries and Worldwide. See what's trending on Google right now with AI-written summaries.`);
  // Open Graph + Twitter Card (sharing + social-indexing signals)
  const ogTags = `
<meta property="og:type" content="website">
<meta property="og:site_name" content="Trendigger">
<meta property="og:title" content="${escAttr(title)}">
<meta property="og:description" content="${desc}">
<meta property="og:url" content="${escAttr(canonicalUrl)}">
${image ? `<meta property="og:image" content="${escAttr(image)}">` : ''}
<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">
<meta name="twitter:title" content="${escAttr(title)}">
<meta name="twitter:description" content="${desc}">
${image ? `<meta name="twitter:image" content="${escAttr(image)}">` : ''}`;
  // Structured data (JSON-LD) for rich results; injected as a <script> in <head>.
  // `jsonLd` may contain multiple top-level nodes joined by newlines; wrap them
  // in a JSON array so the block stays valid JSON.
  const jsonLdTag = jsonLd
    ? `<script type="application/ld+json">[${jsonLd}]</script>`
    : '';
  // Infer current geo from canonicalPath so the header region picker shows it
  const currentGeo = (() => {
    const m = (canonicalPath || '').match(/^\/geo\/([A-Z]{2})\//);
    return (m && GEO_BY_CODE[m[1]]) ? m[1] : 'WW';
  })();
  const currentGeoMeta = GEO_BY_CODE[currentGeo] || GEO_BY_CODE.WW;
  // Region picker options: use flag-icons SVG (select/option only accepts plain text, so a custom dropdown is used)
  const regionOptions = GEOS.map((g) => {
    const href = g.code === 'WW'
      ? `${assetsPrefix}index.html`
      : `${assetsPrefix}geo/${g.code}/index.html`;
    const isCur = g.code === currentGeo;
    return `<a class="region-option${isCur ? ' current' : ''}" href="${escAttr(href)}" role="option"${isCur ? ' aria-current="true"' : ''}>${flagHtml(g.code, g.name)}<span>${escape(g.name)}</span></a>`;
  }).join('');

  return `<!doctype html>
<html lang="${escAttr(lang)}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)} · Trendigger</title>
<meta name="description" content="${desc}">
${ogTags}
<meta name="google-adsense-account" content="ca-pub-4233507772773094">
<link rel="stylesheet" href="${assetsPrefix}assets/style.css">
<link rel="stylesheet" href="${assetsPrefix}assets/flag-icons/css/flag-icons.min.css">
${canonicalTag}
${alternateTags}
${jsonLdTag}
<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-Q4V02GPE7D"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-Q4V02GPE7D');
</script>
<!-- Google AdSense -->
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-4233507772773094" crossorigin="anonymous"></script>
</head>
<body>
<aside class="sidebar" id="sidebar" aria-hidden="true">
  <div class="sidebar-header">
    <span class="sidebar-title">Trend<span class="dot">·</span>igger</span>
    <button class="sidebar-close" id="sidebarClose" aria-label="Close menu">&times;</button>
  </div>
  <div class="sidebar-intro">
    Real-time Google Trends with AI summaries for Worldwide + ${GEOS.length - 1} countries — updated every 4h.
  </div>
  <nav class="sidebar-nav">
    <a href="${assetsPrefix}index.html">Home</a>
    <a href="${assetsPrefix}about.html">About</a>
    <a href="${assetsPrefix}feedback.html">Feedback</a>
    <a href="${assetsPrefix}contact.html">Contact</a>
    <a href="${assetsPrefix}terms.html">Terms</a>
  </nav>
  <div class="sidebar-footer">
    Data from <a href="https://trends.google.com/trending" rel="noopener">Google Trends</a>.
  </div>
</aside>
<div class="sidebar-overlay" id="sidebarOverlay"></div>
<header class="site">
  <div class="inner">
    <button class="sidebar-toggle" id="sidebarToggle" aria-label="Open menu" aria-expanded="false">
      <span></span><span></span><span></span>
    </button>
    <a href="${assetsPrefix}index.html" class="brand">Trend<span class="dot">·</span>igger</a>
    <nav>
      <div class="region-picker" id="regionPicker">
        <button class="region-trigger" type="button" id="regionTrigger" aria-haspopup="listbox" aria-expanded="false">
          <span class="region-flag">${flagHtml(currentGeo, currentGeoMeta.name)}</span>
          <span class="region-name">${escape(currentGeoMeta.name)}</span>
          <svg class="caret" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
        </button>
        <div class="region-menu" id="regionMenu" role="listbox" hidden>
          <input class="region-search" type="search" placeholder="Search locations…" autocomplete="off" id="regionSearch">
          <div class="region-list">${regionOptions}</div>
        </div>
      </div>
    </nav>
  </div>
</header>
<main class="container">
${bodyHtml}
</main>
<footer class="site">
  Data from <a href="https://trends.google.com/trending" rel="noopener">Google Trends</a>.
  Summaries by AI. Updated every 4h. &middot; <a href="${assetsPrefix}index.html">Home</a>
</footer>
<script>
(function(){
  var btn = document.getElementById('sidebarToggle');
  var close = document.getElementById('sidebarClose');
  var side = document.getElementById('sidebar');
  var overlay = document.getElementById('sidebarOverlay');
  function open(){ side.classList.add('open'); overlay.classList.add('show'); btn.setAttribute('aria-expanded','true'); side.setAttribute('aria-hidden','false'); }
  function hide(){ side.classList.remove('open'); overlay.classList.remove('show'); btn.setAttribute('aria-expanded','false'); side.setAttribute('aria-hidden','true'); }
  btn.addEventListener('click', function(){ side.classList.contains('open') ? hide() : open(); });
  close.addEventListener('click', hide);
  overlay.addEventListener('click', hide);
  document.addEventListener('keydown', function(e){ if(e.key==='Escape') hide(); });
})();
// Rewrite "started HH:MM UTC" to the visitor's local timezone
(function(){
  var els = document.querySelectorAll('[data-started]');
  if(!els.length) return;
  try {
    var tz = Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
    els.forEach(function(el){
      var ts = parseInt(el.getAttribute('data-started'), 10);
      if(!ts) return;
      var d = new Date(ts * 1000);
      var s = d.toLocaleString(undefined, { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', timeZone: tz });
      el.textContent = 'started ' + s;
    });
  } catch(e) {}
})();
// Rewrite [data-obs-iso] section titles to relative time based on the visitor's current time
// (11min ago / 1 hour ago / 5 hours ago … / Yesterday / 2026-07-31).
// The first title uses the latest bucket's observed_at, later titles use their own bucket's observed_at,
// so the relative time naturally increases with the time of visit (1h→5h→9h…).
(function(){
  var els = document.querySelectorAll('[data-obs-iso]');
  if(!els.length) return;
  var now = Date.now();
  els.forEach(function(el){
    var iso = el.getAttribute('data-obs-iso');
    if(!iso) return;
    var t = new Date(iso).getTime();
    if(isNaN(t)) return;
    var diffMs = now - t;
    if(diffMs < 0) diffMs = 0;
    var mins = Math.floor(diffMs / 60000);
    if(mins < 1){ el.textContent = 'just now'; return; }
    if(mins < 60){ el.textContent = mins + 'min ago'; return; }
    var hours = Math.floor(mins / 60);
    if(hours < 24){ el.textContent = hours + (hours === 1 ? ' hour ago' : ' hours ago'); return; }
    var days = Math.floor(hours / 24);
    if(days === 1){ el.textContent = 'Yesterday'; return; }
    if(days < 7){ el.textContent = days + ' days ago'; return; }
    var d = new Date(t);
    var y = d.getUTCFullYear();
    var m = String(d.getUTCMonth() + 1).padStart(2, '0');
    var dd = String(d.getUTCDate()).padStart(2, '0');
    el.textContent = y + '-' + m + '-' + dd;
  });
})();
// Region picker custom dropdown: click trigger to toggle, click outside/Esc to close, with search filter
(function(){
  var picker = document.getElementById('regionPicker');
  if(!picker) return;
  var trigger = document.getElementById('regionTrigger');
  var menu = document.getElementById('regionMenu');
  var search = document.getElementById('regionSearch');
  function filter(q){
    var ql = q.toLowerCase().trim();
    menu.querySelectorAll('.region-option').forEach(function(opt){
      opt.style.display = (!ql || opt.textContent.toLowerCase().indexOf(ql) !== -1) ? '' : 'none';
    });
  }
  function toggle(open){
    picker.classList.toggle('open', open);
    trigger.setAttribute('aria-expanded', open?'true':'false');
    menu.hidden = !open;
    if(open && search){ search.value=''; filter(''); setTimeout(function(){ search.focus(); }, 0); }
  }
  trigger.addEventListener('click', function(e){ e.stopPropagation(); toggle(menu.hidden); });
  if(search){
    search.addEventListener('input', function(){ filter(search.value); });
    search.addEventListener('click', function(e){ e.stopPropagation(); });
  }
  document.addEventListener('click', function(e){ if(!picker.contains(e.target)) toggle(false); });
  document.addEventListener('keydown', function(e){ if(e.key==='Escape') toggle(false); });
})();
// Reveal a folded tier and eagerly load its (lazy) images.
function revealTier(id, btn){
  var tier = document.getElementById(id);
  if(!tier) return;
  tier.hidden = false;
  tier.querySelectorAll('img.lazy-img[data-src]').forEach(function(im){
    im.src = im.dataset.src; im.removeAttribute('data-src');
  });
  if(btn) btn.style.display = 'none';
}
// Lazy-load images: defer fetching until they approach the viewport.
(function(){
  var imgs = document.querySelectorAll('img.lazy-img[data-src]');
  if(!imgs.length) return;
  if(!('IntersectionObserver' in window)){
    imgs.forEach(function(im){ im.src = im.dataset.src; im.removeAttribute('data-src'); });
    return;
  }
  var io = new IntersectionObserver(function(entries){
    entries.forEach(function(e){
      if(e.isIntersecting){
        var im = e.target;
        im.src = im.dataset.src; im.removeAttribute('data-src');
        io.unobserve(im);
      }
    });
  }, { rootMargin: '300px 0px' });
  imgs.forEach(function(im){ io.observe(im); });
})();
// Date picker: navigate to the selected date's page if data exists for it.
(function(){
  var inputs = document.querySelectorAll('input[type="date"][data-date-set]');
  if(!inputs.length) return;
  inputs.forEach(function(inp){
    inp.addEventListener('change', function(){
      var v = inp.value;
      if(!v) return;
      var ok = JSON.parse(inp.getAttribute('data-date-set') || '{}');
      if(!ok[v]){
        alert('No data for ' + v + '. Available: ' + Object.keys(ok).sort().join(', '));
        inp.value = inp.getAttribute('data-current') || '';
        return;
      }
      var p = inp.getAttribute('data-href-prefix') || '';
      var ls = inp.getAttribute('data-lang-suffix') || '';
      location.href = p + v + '.html' + ls;
    });
  });
})();
</script>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Trend card (used on geo index and geo-date pages)

/**
 * @param {object} o
 * @param {import('./fetchTrends.js').TrendItem & {intro?: string|null, news?: any[]}} o.trend
 * @param {string} o.geoCode
 * @param {string} o.assetsPrefix - relative to page (e.g. "../../")
 * @param {string} [o.lang] - render language; when 'en' (and the card's geo is non-English) link to the English variant
 */
export function trendCard({ trend, geoCode, assetsPrefix, extraClass = '', showGeoFlag = false, lang }) {
  const t = trend;
  // On the WW aggregate page each keyword comes from a different geo; use the source geo for links
  const linkGeo = showGeoFlag && t.geo ? t.geo : geoCode;
  const cardGeo = GEO_BY_CODE[linkGeo] || {};
  const enVariant = cardGeo.lang && cardGeo.lang !== 'en' && lang === 'en';
  const langSuffix = enVariant ? '?lang=en' : '';
  const hasPic = !!t.picture;
  // Thumbnail fallback: first letter of the keyword
  const initial = escape((t.keyword || '?').trim().charAt(0).toUpperCase());
  const vol = t.search_volume_raw || formatInt(t.search_volume_num ?? 0);
  const startedTs = Number(t.started_at);
  let started = null;
  if (startedTs > 0) {
    const d = new Date(startedTs * 1000);
    if (!Number.isNaN(d.getTime())) {
      started = d.toISOString().slice(11, 16) + ' UTC';
    }
  }
  const news = Array.isArray(t.news_json)
    ? t.news_json
    : typeof t.news_json === 'string'
      ? safeJson(t.news_json, [])
      : (t.news ?? []);

  // On the WW aggregate page each keyword comes from a different geo; show the source flag to tell them apart
  // (showGeoFlag is true only on the WW page; false on regular geo pages hides it)
  // Flag now links to the corresponding country page with a hover tooltip
  const sourceFlag = showGeoFlag && t.geo
    ? (() => {
        const g = GEO_BY_CODE[t.geo];
        const geoName = g ? g.name : t.geo;
        const title = `Explore more trends in ${geoName}`;
        const geoHref = `${assetsPrefix}geo/${t.geo}/index.html`;
        return `<a class="geo-flag" href="${escAttr(geoHref)}" title="${escAttr(title)}" aria-label="${escAttr(title)}">${flagHtml(t.geo)}</a>`;
      })()
    : '';

  const newsHtml = news.length
    ? `<div class="news">
         <h3>Related news</h3>
         <ul>
           ${news.slice(0, 5).map((n) => {
             const src = n.sources?.length ? n.sources.join(', ') : '';
             const pic = n.picture ? `<img class="lazy-img" data-src="${escAttr(n.picture)}" alt="" loading="lazy" onerror="this.remove()">` : '';
             return `<li>
               ${pic}
               <a href="${escAttr(n.url || '#')}" rel="noopener" target="_blank">${escape(n.title)}</a>
               ${src ? `<span class="src">— ${escape(src)}</span>` : ''}
             </li>`;
           }).join('')}
         </ul>
       </div>`
    : '';

  const detailHref = `${assetsPrefix}geo/${linkGeo}/${keywordHref(t.keyword)}${langSuffix}`;
  const shareKeywordEncoded = encodeURIComponent(t.keyword);
  const cardGoogleUrl = `https://www.google.com/search?q=${shareKeywordEncoded}`;
  const cardShareUrl = `${SITE_BASE}/geo/${linkGeo}/keyword/${encodeURIComponent(keywordToSlug(t.keyword))}.html${langSuffix}`;
  const cardEncodedShareUrl = encodeURIComponent(cardShareUrl);
  const cardShareText = buildShareText({
    keyword: t.keyword,
    intro: t.intro,
    currentVolume: vol,
  });

  return `<article class="card ${extraClass}">
  <div class="head">
    <div class="thumb">
      ${hasPic
        ? `<img class="lazy-img" data-src="${escAttr(t.picture)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`
        : initial}
    </div>
    <div class="head-text">
      <h2><span class="rank">#${t.rank}</span>${sourceFlag}<a href="${escAttr(detailHref)}">${escape(t.keyword)}</a></h2>
      <div class="meta">
        <span class="badge hot">${escape(vol)} searches</span>
        ${started ? `<span class="badge" data-started="${t.started_at}">started ${escape(started)}</span>` : ''}
      </div>
    </div>
  </div>
  ${t.intro ? `<div class="intro">${escape(t.intro)}</div>` : ''}
  ${newsHtml}
  <div class="footer">
    <a href="${escAttr(detailHref)}">View history &rarr;</a>
    <div class="card-actions">
      <a href="${escAttr(cardGoogleUrl)}" class="icon-btn" target="_blank" rel="noopener" aria-label="Search on Google" title="Search on Google">
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><line x1="16.5" y1="16.5" x2="21" y2="21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </a>
      <a href="https://twitter.com/intent/tweet?url=${cardEncodedShareUrl}&text=${encodeURIComponent(cardShareText)}" class="icon-btn" target="_blank" rel="noopener" aria-label="Share on X" title="Share on X">
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
      </a>
      <a href="https://www.facebook.com/sharer/sharer.php?u=${cardEncodedShareUrl}" class="icon-btn" target="_blank" rel="noopener" aria-label="Share on Facebook" title="Share on Facebook">
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
      </a>
    </div>
  </div>
</article>`;
}

function safeJson(s, fb) { try { return JSON.parse(s); } catch { return fb; } }

// ---------------------------------------------------------------------------
// Geo page (latest OR a specific historical date)

/**
 * @param {object} o
 * @param {object} o.geoMeta   - from GEOS[]
 * @param {string} o.date      - 'YYYY-MM-DD'
 * @param {boolean} o.isLatest - if this page is /geo/XX/index.html
 * @param {object[]} o.trends  - rows from DB, each with intro/news_json
 * @param {string[]} o.availableDates - for nav (most recent first)
 * @param {string} [o.lang]    - render language ('en' or geoMeta.lang)
 */
export function geoPage({ geoMeta, date, isLatest, trends, availableDates, lang, buckets = [] }) {
  const assetsPrefix = '../../';
  const flag = flagHtml(geoMeta.code, geoMeta.name);
  const renderLang = lang || geoMeta.lang;

  // canonical / hreflang basePath: latest uses /geo/XX/, date pages use /geo/XX/date.html
  const basePath = isLatest
    ? `/geo/${geoMeta.code}/`
    : `/geo/${geoMeta.code}/${date}.html`;
  const enVariant = isEnVariantPage(geoMeta, renderLang);
  const canonicalPath = enVariant ? `${basePath}?lang=en` : basePath;
  const alternates = buildAlternates(geoMeta, basePath);
  const langSwitch = buildLangSwitch(geoMeta, renderLang, basePath);

  const dateNav = buildDateNav(availableDates, date, isLatest, '', renderLang);
  const showGeoFlag = geoMeta.code === 'WW';

  // Latest page ("last 24 hours"): single-column 4h buckets. Historical date
  // pages: a single column (unified top 100). Both progressively reveal tiers.
  const listHtml = isLatest && buckets.length
    ? renderBucketPairs(buckets, {
        geoCode: geoMeta.code, assetsPrefix, showGeoFlag, lang: renderLang,
      })
    : renderTieredGrid(trends, {
        geoCode: geoMeta.code, assetsPrefix, showGeoFlag, lang: renderLang,
      });

  // SEO-friendly title + subtitle. Latest = "for last 24 hours"; historical = "for YYYY-MM-DD".
  const titleDate = isLatest ? 'last 24 hours' : date;
  const h1 = `${geoMeta.name} Google Trends for ${titleDate}`;
  const bucketItems = isLatest && buckets.length ? buckets.flatMap((b) => b.items) : [];
  const sub = `Top ${roundTopN(isLatest ? bucketItems.length : trends.length)} searches`;

  // SEO description: keyword-rich, mirrors real search intent
  // ("google trends [country]", "trending now", "top searches today").
  const desc = isLatest
    ? `See the top Google Trends in ${geoMeta.name} right now. Discover what's trending on Google today in ${geoMeta.name} — ${roundTopN(bucketItems.length)} trending searches with AI-written summaries.`
    : `Google Trends in ${geoMeta.name} for ${date}. Explore the ${roundTopN(trends.length)} top trending searches of the day and what people searched for on Google.`;

  // Indexable prose paragraph intentionally omitted to keep geo pages lean.
  const prose = '';

  // JSON-LD: ItemList of trending keywords (rich-result eligible) + BreadcrumbList.
  // Latest page lists the union of bucket items; historical page lists the day's trends.
  const seoItems = isLatest && bucketItems.length ? bucketItems : trends;
  const itemListJson = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: h1,
    itemListElement: seoItems.slice(0, 100).map((t, i) => {
      const linkGeo = showGeoFlag && t.geo ? t.geo : geoMeta.code;
      return {
        '@type': 'ListItem',
        position: i + 1,
        name: t.keyword,
        url: `${SITE_BASE}/geo/${linkGeo}/${keywordHref(t.keyword)}${enVariant ? '?lang=en' : ''}`,
      };
    }),
  });
  const crumbJson = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE_BASE}/` },
      { '@type': 'ListItem', position: 2, name: `${geoMeta.name} Google Trends`, item: `${SITE_BASE}/geo/${geoMeta.code}/` },
    ],
  });
  const jsonLd = itemListJson + ',' + crumbJson;

  const body = `
  <h1 class="page-title">
    <span class="flag">${flag}</span>
    <span>${escape(h1)}</span>
  </h1>
  <p class="page-sub">${escape(sub)}</p>
  ${prose}
  ${langSwitch}
  ${dateNav}
  ${listHtml}`;

  return layout({
    title: h1,
    lang: renderLang,
    assetsPrefix,
    bodyHtml: body,
    canonicalPath,
    alternates,
    description: desc,
    jsonLd,
  });
}

// Round the number of trends shown in the subtitle to a clean, SEO-friendly
// bucket: 1-10 -> 10, 11-20 -> 20, 21-30 -> 30, 31-50 -> 50, 51+ -> 100.
function roundTopN(n) {
  if (n <= 10) return 10;
  if (n <= 20) return 20;
  if (n <= 30) return 30;
  if (n <= 50) return 50;
  return 100;
}

// Render all trend cards in a single grid. Images are lazy-loaded by the
// IntersectionObserver in layout() as they approach the viewport.
function renderTieredGrid(trends, opts) {
  if (!trends.length) return '<p>No data for this date.</p>';

  const html = trends
    .map((t) => trendCard({ trend: t, ...opts }))
    .join('\n');

  return `<div class="trend-grid">${html}</div>`;
}

// Render a bucket grid: first 20 cards visible, the rest hidden behind a single
// "Show more" button. Used on the homepage / geo-latest 4h-bucket columns where
// each bucket can have up to 100 items and we want a single expand action.
function renderBucketGrid(trends, opts) {
  const total = trends.length;
  if (total === 0) return '<p>No data for this time slot.</p>';

  const cardsHtml = (from, to) =>
    trends
      .slice(from, to)
      .map((t) => trendCard({ trend: t, ...opts }))
      .join('\n');

  const firstStep = Math.min(20, total);
  let html = `<div class="trend-grid">${cardsHtml(0, firstStep)}</div>`;

  if (total > firstStep) {
    const remaining = total - firstStep;
    const tierId = `tier-bucket-${Math.random().toString(36).slice(2, 8)}`;
    html += `<div class="tier" id="${tierId}" hidden>
      <div class="trend-grid">${cardsHtml(firstStep, total)}</div>
    </div>
    <button class="btn-show-more" type="button" onclick="revealTier('${tierId}', this)">Show ${remaining} more &darr;</button>`;
  }

  return html;
}

// ---------------------------------------------------------------------------
// Date navigation

function buildDateNav(dates, current, isLatest, dateHrefPrefix = '', lang) {
  if (!dates || !dates.length) return '';

  const ls = lang === 'en' ? '?lang=en' : '';

  // When on the Latest page, "Latest" already represents dates[0] (the most
  // recent date). Showing it again as a pill is redundant — clicking it would
  // lead to identical content. Skip it so the pills start from the previous
  // day, giving users a clear path to older data.
  const pillsDates = isLatest ? dates.slice(1, 8) : dates.slice(0, 7);

  const sortedAsc = [...dates].sort();  // for min/max on date picker
  const minDate = sortedAsc[0];
  const maxDate = sortedAsc[sortedAsc.length - 1];

  // Small JSON map "YYYY-MM-DD" -> true so the picker can reject dates without data.
  const dateSetJs = JSON.stringify(Object.fromEntries(dates.map((d) => [d, 1])));

  // Date picker: accepts only dates that exist in our archive. Navigation logic
  // is handled by the global datepicker initializer in layout() via data attributes.
  const picker = `
    <label class="datepicker" title="Jump to a specific day">
      <input type="date" min="${escape(minDate)}" max="${escape(maxDate)}"
             value="${escape(current)}"
             data-date-set='${escAttr(dateSetJs)}'
             data-href-prefix='${escAttr(dateHrefPrefix)}'
             data-lang-suffix='${escAttr(ls)}'
             data-current='${escape(current)}'>
    </label>`;

  const pills = [
    isLatest
      ? `<span class="current">Latest</span>`
      : `<a href="index.html${ls}">Latest</a>`,
    ...pillsDates.map((d) =>
      d === current && !isLatest
        ? `<span class="current">${escape(d)}</span>`
        : `<a href="${escape(dateHrefPrefix)}${escape(d)}.html${ls}">${escape(d)}</a>`,
    ),
  ].filter(Boolean);

  return `<div class="datebar">
    ${pills.join('')}
    ${picker}
  </div>`;
}

// ---------------------------------------------------------------------------
// Geo archive page (list of all historical dates)

export function geoArchivePage({ geoMeta, dates }) {
  const assetsPrefix = '../../';
  const flag = flagHtml(geoMeta.code, geoMeta.name);
  const body = `
  <h1 class="page-title">
    <span class="flag">${flag}</span>
    <span>${escape(geoMeta.name)} · Archive</span>
  </h1>
  <p class="page-sub">${dates.length} historical dates available.</p>
  <ul style="list-style:none; padding:0; display:grid; gap:6px;">
    ${dates.map((d) => `<li><a href="${escape(d)}.html">${escape(d)}</a></li>`).join('')}
  </ul>`;
  return layout({
    title: `${geoMeta.name} archive`,
    lang: geoMeta.lang,
    assetsPrefix,
    bodyHtml: body,
  });
}

// ---------------------------------------------------------------------------
// Keyword detail page

/**
 * @param {object} o
 * @param {object} o.geoMeta
 * @param {string} o.keyword
 * @param {string|null} o.intro
 * @param {object[]} o.history - rows from trend_snapshots (peak per date) for this keyword,
 *        ordered by date DESC. fields: date, rank, search_volume_num,
 *        search_volume_raw, started_at, news_json
 * @param {string} [o.lang] - render language
 */
export function keywordPage({ geoMeta, keyword, intro, history, lang, geoCount = 0, topGeos = [] }) {
  const assetsPrefix = '../../../';
  const flag = flagHtml(geoMeta.code, geoMeta.name);
  const renderLang = lang || geoMeta.lang;
  const latest = history[0];

  // Countries where this keyword recently appeared (across geos): flag row + count.
  const enVariant = isEnVariantPage(geoMeta, renderLang);
  const langSuffix = enVariant ? '?lang=en' : '';
  const countriesRow = geoCount > 0
    ? `<div class="keyword-geos">
         <span class="muted">Trending in <strong>${geoCount}</strong> ${geoCount === 1 ? 'country' : 'countries'}:</span>
         ${topGeos.map((code) => {
           const g = GEO_BY_CODE[code];
           if (!g) return '';
           return `<a href="../../${g.code}/index.html${langSuffix}" class="flag-link" title="${escAttr(g.name)}">${flagHtml(g.code, g.name)}</a>`;
         }).join(' ')}
         ${geoCount > topGeos.length ? '<span class="muted">…</span>' : ''}
       </div>`
    : '';

  const peak = history.reduce(
    (m, r) => (r.search_volume_num > m ? r.search_volume_num : m),
    0,
  );
  const firstDate = history[history.length - 1]?.date;
  const lastDate = history[0]?.date;
  const spanDays = firstDate
    ? Math.max(1, Math.round((new Date(lastDate) - new Date(firstDate)) / 86400000) + 1)
    : 1;

  const latestNews = latest?.news_json ? safeJson(latest.news_json, []) : [];

  const encodedKeyword = encodeURIComponent(keyword);
  const keywordSlug = keywordToSlug(keyword);
  const basePath = `/geo/${geoMeta.code}/keyword/${encodeURIComponent(keywordSlug)}.html`;
  const canonicalPath = basePath + langSuffix;
  const alternates = buildAlternates(geoMeta, basePath);
  const langSwitch = buildLangSwitch(geoMeta, renderLang, basePath);
  const canonicalUrl = `${SITE_BASE}${canonicalPath}`;
  const encodedUrl = encodeURIComponent(canonicalUrl);
  const googleSearchUrl = `https://www.google.com/search?q=${encodedKeyword}`;
  const shareText = buildShareText({
    keyword,
    intro,
    peakVolume: peak,
    daysTrending: history.length,
  });
  const copyText = escapeJsString(shareText + '\n\n' + canonicalUrl);

  const shareButtonsHtml = `
  <div class="keyword-actions">
    <a href="${escAttr(googleSearchUrl)}" class="btn btn-google" target="_blank" rel="noopener">
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><line x1="16.5" y1="16.5" x2="21" y2="21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      Search on Google
    </a>
    <div class="share-buttons">
      <span class="share-label">Share:</span>
      <a href="https://twitter.com/intent/tweet?url=${encodedUrl}&text=${encodeURIComponent(shareText)}" class="btn-share btn-twitter" target="_blank" rel="noopener" aria-label="Share on X">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
      </a>
      <a href="https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}" class="btn-share btn-facebook" target="_blank" rel="noopener" aria-label="Share on Facebook">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
      </a>
      <a href="https://www.linkedin.com/sharing/share-offsite/?url=${encodedUrl}" class="btn-share btn-linkedin" target="_blank" rel="noopener" aria-label="Share on LinkedIn">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.063 2.063 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
      </a>
      <button class="btn-share btn-copy" onclick="(function(){var text='${copyText}';navigator.clipboard.writeText(text).then(function(){var b=document.querySelector('.btn-copy');b.setAttribute('aria-label','Copied!');b.querySelector('span').textContent='✓';setTimeout(function(){b.setAttribute('aria-label','Copy post text & link');b.querySelector('span').textContent='🔗';},2000);});})()" aria-label="Copy post text & link">
        <span>🔗</span>
      </button>
    </div>
  </div>`;

  // Sparkline-ish bar timeline (pure HTML; per-day peak volume, width normalized to peak)
  const timeline = history
    .slice()
    .reverse()
    .map((r) => {
      const pct = peak > 0 ? Math.max(3, Math.round((r.search_volume_num / peak) * 100)) : 3;
      const volLabel = r.search_volume_raw || formatInt(r.search_volume_num);
      return `<div class="row">
        <div><a href="../${escape(r.date)}.html${langSuffix}" style="color:var(--text)">${escape(r.date)}</a></div>
        <div><div class="bar" style="width:${pct}%"></div></div>
        <div><span class="badge">${escape(volLabel)}</span></div>
      </div>`;
    })
    .join('');

  const newsHtml = latestNews.length
    ? `<ul style="margin:0;padding:0;list-style:none;display:grid;gap:8px;">
         ${latestNews.map((n) => {
           const src = n.sources?.length ? n.sources.join(', ') : '';
           const pic = n.picture ? `<img src="${escAttr(n.picture)}" alt="" loading="lazy" style="width:48px;height:48px;object-fit:cover;border-radius:6px;margin-right:10px;vertical-align:middle;" onerror="this.remove()">` : '';
           return `<li style="display:flex;align-items:flex-start;">
             ${pic}
             <div>
               <a href="${escAttr(n.url || '#')}" rel="noopener" target="_blank">${escape(n.title)}</a>
               ${src ? `<span class="src" style="color:var(--text-muted);font-size:12px;">— ${escape(src)}</span>` : ''}
             </div>
           </li>`;
         }).join('')}
       </ul>`
    : '<p style="color:var(--text-muted);">No news recorded.</p>';

  const body = `
  <p class="page-sub"><a href="../index.html${langSuffix}">&larr; ${escape(geoMeta.name)}</a></p>
  <h1 class="page-title">
    <span class="flag">${flag}</span>
    <span>${escape(keyword)}</span>
  </h1>

  ${langSwitch}
  ${shareButtonsHtml}

  ${intro ? `<div class="detail-intro"><p>${escape(intro)}</p></div>` : ''}
  ${countriesRow}

  <div class="stats">
    <div class="stat"><div class="label">Peak volume</div><div class="value">${escape(formatInt(peak))}</div></div>
    <div class="stat"><div class="label">First seen</div><div class="value">${escape(firstDate ?? 'n/a')}</div></div>
    <div class="stat"><div class="label">Last seen</div><div class="value">${escape(lastDate ?? 'n/a')}</div></div>
    <div class="stat"><div class="label">Days trending</div><div class="value">${history.length} / ${spanDays}</div></div>
    <div class="stat"><div class="label">Countries</div><div class="value">${geoCount || '—'}</div></div>
  </div>

  <h2 class="section-title">Trending timeline</h2>
  <div class="timeline">${timeline}</div>

  <h2 class="section-title">Latest related news (${escape(lastDate ?? '')})</h2>
  ${newsHtml}`;

  // SEO description for the keyword page (keyword-rich, mirrors search intent).
  const desc = intro
    ? `${escape(keyword)} is trending on Google in ${geoMeta.name}. ${intro.split('.')[0]}. See its peak search volume, how long it's been trending, and the latest news.`
    : `Why is ${escape(keyword)} trending on Google in ${geoMeta.name}? See its peak search volume, ${history.length} days trending, and the latest related news.`;

  // JSON-LD: Article (rich-result eligible) + BreadcrumbList.
  const articleJson = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: `${keyword} — Google Trends in ${geoMeta.name}`,
    description: desc,
    ...(intro ? { articleBody: intro } : {}),
    datePublished: firstDate ? `${firstDate}T00:00:00Z` : undefined,
    dateModified: lastDate ? `${lastDate}T00:00:00Z` : undefined,
    mainEntityOfPage: { '@type': 'WebPage', '@id': canonicalUrl },
  });
  const crumbJson = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE_BASE}/` },
      { '@type': 'ListItem', position: 2, name: `${geoMeta.name} Google Trends`, item: `${SITE_BASE}/geo/${geoMeta.code}/` },
      { '@type': 'ListItem', position: 3, name: keyword, item: canonicalUrl },
    ],
  });
  const jsonLd = articleJson + ',' + crumbJson;

  return layout({
    title: `${keyword} · ${geoMeta.name}`,
    lang: renderLang,
    assetsPrefix,
    bodyHtml: body,
    canonicalPath,
    alternates,
    description: desc,
    jsonLd,
    image: latest?.picture || latestNews.find((n) => n.picture)?.picture || undefined,
  });
}

// ---------------------------------------------------------------------------
// Home page — Worldwide TOP 100 by search volume, with a region switcher.

/**
 * @param {object} o
 * @param {object[]} o.items - WW latest-bucket snapshots (already ranked 1..N by volume)
 * @param {string[]} [o.availableDates] - WW historical dates for datebar (most recent first)
 * @param {string} [o.geoCode='WW'] - which geo this home view represents
 * @param {string} [o.latestTimeIso] - ISO form of the latest bucket's observed_at (for client-side relative time)
 * @param {{label:string, items:object[], obsIso?:string}[]} [o.sections] - earlier time-ago sections
 */
// Render 4-hour time buckets as a single vertical column: one time slot per
// column, newest-first (1h ago, then 5h ago, 9h ago, ... up to the last 24h).
// Each bucket's cards are progressively revealed (20 → 50 → 100) with
// lazy-loaded images, matching the single-column optimization.
function renderBucketPairs(buckets, { geoCode, assetsPrefix, showGeoFlag, lang }) {
  if (!buckets.length) return '<p>No data for the last 24 hours.</p>';
  let html = '<div class="bucket-pairs">';
  for (let i = 0; i < buckets.length; i++) {
    const prevId = i > 0 ? `bucket-${escAttr(buckets[i - 1].label)}` : '';
    const nextId = i < buckets.length - 1 ? `bucket-${escAttr(buckets[i + 1].label)}` : '';
    html += renderBucket(buckets[i], { geoCode, assetsPrefix, showGeoFlag, lang, prevId, nextId });
  }
  html += '</div>';
  return html;
}

function renderBucket(b, { geoCode, assetsPrefix, showGeoFlag, lang, prevId = '', nextId = '' }) {
  const cards = renderBucketGrid(b.items, {
    geoCode, assetsPrefix, showGeoFlag, lang,
  });
  const navBtns = `
    <span class="bucket-nav">
      <a class="bucket-nav-btn${prevId ? '' : ' is-disabled'}"${prevId ? ` href="#${prevId}"` : ''} aria-label="Previous time slot">&#8592; back</a>
      <a class="bucket-nav-btn${nextId ? '' : ' is-disabled'}"${nextId ? ` href="#${nextId}"` : ''} aria-label="Next time slot">next &#8594;</a>
    </span>`;
  return `<section class="bucket" id="bucket-${escAttr(b.label)}">
  <h2 class="section-title">${escape(b.label)}${navBtns}</h2>
  ${cards || '<p>No data for this time slot.</p>'}
</section>`;
}

export function homePage({ buckets = [], availableDates = [], geoCode = 'WW' }) {
  const geoMeta = GEO_BY_CODE[geoCode] || GEO_BY_CODE.WW;
  const isWW = geoCode === 'WW';
  // WW is always the English summary view
  const renderLang = 'en';

  // Single vertical column of 4-hour time buckets (newest-first):
  // 1h ago, 5h ago, 9h ago, ... up to the last 24h, each in its own column.
  const listHtml = renderBucketPairs(buckets, {
    geoCode, assetsPrefix: '', showGeoFlag: true, lang: renderLang,
  });

  // Total number of trending topics shown (across all buckets) for the subtitle.
  const totalItems = buckets.reduce((n, b) => n + b.items.length, 0);

  // Older-date navigation placed ABOVE the list, matching the geo pages.
  const dateNav = isWW ? buildHomeDateNav(availableDates, 'geo/WW/') : '';

  const titleFlag = flagHtml(geoCode, geoMeta.name);
  const h1 = `${geoMeta.name} Google Trends for last 24 hours`;
  const sub = `Top ${roundTopN(totalItems)} searches`;

  // SEO description for the Worldwide / geo home page.
  const desc = isWW
    ? `See the top Google Trends Worldwide right now. Discover what's trending on Google today across the world — ${roundTopN(totalItems)} trending searches with AI-written summaries.`
    : `See the top Google Trends in ${geoMeta.name} right now. Discover what's trending on Google today in ${geoMeta.name} — ${roundTopN(totalItems)} trending searches with AI-written summaries.`;

  // JSON-LD: ItemList + BreadcrumbList for rich results (union of bucket items).
  const allItems = buckets.flatMap((b) => b.items).slice(0, 100);
  const itemListJson = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: h1,
    itemListElement: allItems.map((t, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: t.keyword,
      url: `${SITE_BASE}/geo/${isWW && t.geo ? t.geo : geoCode}/${keywordHref(t.keyword)}`,
    })),
  });
  const crumbJson = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE_BASE}/` }],
  });
  const jsonLd = itemListJson + ',' + crumbJson;

  const body = `
  <h1 class="page-title">
    <span class="flag">${titleFlag}</span>
    <span>${escape(h1)}</span>
  </h1>
  <p class="page-sub">${escape(sub)}</p>
  ${dateNav}
  ${listHtml}`;

  return layout({
    title: h1,
    lang: renderLang,
    assetsPrefix: '',
    bodyHtml: body,
    canonicalPath: '/',
    description: desc,
    jsonLd,
  });
}

// Home-page bottom "older dates" navigation: only date pills + datepicker, no "Latest" pill.
// WW date pages are dynamically aggregated by Pages Functions.
function buildHomeDateNav(dates, dateHrefPrefix) {
  if (!dates || !dates.length) return '';
  const pillsDates = dates.slice(0, 7);
  const sortedAsc = [...dates].sort();
  const minDate = sortedAsc[0];
  const maxDate = sortedAsc[sortedAsc.length - 1];
  const dateSetJs = JSON.stringify(Object.fromEntries(dates.map((d) => [d, 1])));

  const picker = `
    <label class="datepicker" title="Jump to a specific day">
      <input type="date" min="${escape(minDate)}" max="${escape(maxDate)}"
             data-date-set='${escAttr(dateSetJs)}'
             data-href-prefix='${escAttr(dateHrefPrefix)}'>
    </label>`;

  const pills = pillsDates.map((d) =>
    `<a href="${escAttr(dateHrefPrefix)}${escape(d)}.html">${escape(d)}</a>`);

  return `<div class="datebar">
    <span class="datebar-label">Older dates</span>
    ${pills.join('')}
    ${picker}
  </div>`;
}

// ---------------------------------------------------------------------------
// Static content pages (About, Terms, Feedback, Contact)

export function aboutPage() {
  const body = `
  <a class="back-link" href="index.html">&larr; Back to home</a>
  <div class="static-page">
    <h1>About Trend&middot;igger</h1>
    <p>
      Trend&middot;igger tracks <strong>Google Trends</strong> search interest
      across a Worldwide view plus ${GEOS.length - 1} countries. Every 4 hours we collect the
      latest trending searches, rank them by volume, and generate AI-written
      summaries to give you instant context on what the world is searching for.
    </p>
    <h2>What we do</h2>
    <ul>
      <li>Collect trending search data from Google Trends Trending Now (every 4h)</li>
      <li>Rank topics by search volume so the hottest trends appear first</li>
      <li>Generate AI summaries for each keyword — a one-sentence brief to
          understand the topic at a glance</li>
      <li>Archive daily snapshots so you can browse historical trends by region
          and date</li>
      <li>Provide keyword detail pages showing full timelines, peak volumes,
          and related news</li>
    </ul>
    <h2>Who it's for</h2>
    <p>
      Journalists, marketers, researchers, and the curious. If you've ever
      wondered <em>"what is the world searching for right now?"</em> — this
      site is for you.
    </p>
    <h2>Regions covered</h2>
    <p>
      We currently track trends across ${GEOS.length} regions including
      the United States, Japan, South Korea, India, Australia, and more.
      New regions are added based on demand.
    </p>
    <h2>How summaries are generated</h2>
    <p>
      Each trending keyword gets a short AI-generated summary explaining what
      the topic is and why it's trending. These summaries are powered by
      large language models and are regenerated periodically as new data
      becomes available. Summaries may not always be accurate — always
      verify important information from primary sources.
    </p>
    <h2>Disclaimer</h2>
    <p>
      Trend&middot;igger is an independent project and is not affiliated with,
      endorsed by, or sponsored by Google LLC. All trend data is sourced from
      Google Trends Trending Now. Google and Google Trends are trademarks of
      Google LLC.
    </p>
  </div>`;

  return layout({
    title: 'About',
    lang: 'en',
    assetsPrefix: '',
    bodyHtml: body,
  });
}

export function termsPage() {
  const body = `
  <a class="back-link" href="index.html">&larr; Back to home</a>
  <div class="static-page">
    <h1>Terms of Use</h1>
    <p>Last updated: 2026-07-26</p>

    <h2>1. Service description</h2>
    <p>
      Trend&middot;igger provides a free, publicly accessible interface to
      explore Google Trends data across multiple regions. The service includes
      AI-generated summaries for trending keywords and related news links.
    </p>

    <h2>2. Data source</h2>
    <p>
      All trend data is sourced from Google Trends Trending Now. This site is
      not affiliated with, endorsed by, or sponsored by Google LLC. Google
      and Google Trends are trademarks of Google LLC.
    </p>

    <h2>3. AI-generated content</h2>
    <p>
      Keyword summaries are generated by artificial intelligence models.
      While we strive for accuracy, AI-generated content may contain errors,
      inaccuracies, or outdated information. You should not rely on summaries
      as the sole source of information. Always verify important facts from
      primary sources before making decisions based on this site's content.
    </p>

    <h2>4. No warranty</h2>
    <p>
      The service is provided "as is" without warranties of any kind, express
      or implied. We do not guarantee the accuracy, completeness, or
      timeliness of any data or summaries presented on this site.
    </p>

    <h2>5. Limitation of liability</h2>
    <p>
      In no event shall the operators of this site be liable for any claims,
      damages, or other liabilities arising from the use of this service or
      the reliance on any information presented herein.
    </p>

    <h2>6. Acceptable use</h2>
    <p>
      You may use this service for personal, educational, and research
      purposes. You may not use this service for any unlawful purpose, nor
      attempt to access, reverse-engineer, or disrupt the service in any way.
    </p>
  </div>`;

  return layout({
    title: 'Terms of Use',
    lang: 'en',
    assetsPrefix: '',
    bodyHtml: body,
  });
}

export function feedbackPage() {
  const body = `
  <a class="back-link" href="index.html">&larr; Back to home</a>
  <div class="static-page">
    <h1>Feedback</h1>
    <p>
      We'd love to hear from you! Your feedback helps us improve Trend&middot;igger.
      Whether it's a bug report, a feature request, or just a comment — please
      let us know.
    </p>

    <h2>Report a bug</h2>
    <p>
      Found something broken? Tell us what happened, which page or region you
      were looking at, and what browser you're using. Screenshots are very
      helpful.
    </p>

    <h2>Suggest a feature</h2>
    <p>
      Got an idea that would make this site better? More regions? Different
      sorting? A dark mode toggle? We're all ears.
    </p>

    <h2>How to reach us</h2>
    <p>
      The best way to send feedback is via email. Just describe your issue or
      idea and we'll get back to you as soon as we can.
    </p>
    <p>
      <a href="mailto:hello@trendigger.com">hello@trendigger.com</a>
    </p>
  </div>`;

  return layout({
    title: 'Feedback',
    lang: 'en',
    assetsPrefix: '',
    bodyHtml: body,
  });
}

export function contactPage() {
  const body = `
  <a class="back-link" href="index.html">&larr; Back to home</a>
  <div class="static-page">
    <h1>Contact</h1>

    <h2>General inquiries</h2>
    <p>
      For general questions about Trend&middot;igger, partnerships, or
      press inquiries, please reach out to:
    </p>
    <p><a href="mailto:hello@trendigger.com">hello@trendigger.com</a></p>

    <h2>Technical issues & feedback</h2>
    <p>
      If you're experiencing technical problems or have suggestions,
      email us with a brief description. Screenshots are very helpful for
      bug reports.
    </p>
    <p><a href="mailto:hello@trendigger.com">hello@trendigger.com</a></p>

    <h2>Data & privacy</h2>
    <p>
      Trend&middot;igger is a minimal, privacy-friendly service. We do not
      require user accounts, do not track personal data beyond basic
      analytics, and do not sell or share any information. For questions
      about data handling, please contact:
    </p>
    <p><a href="mailto:hello@trendigger.com">hello@trendigger.com</a></p>
  </div>`;

  return layout({
    title: 'Contact',
    lang: 'en',
    assetsPrefix: '',
    bodyHtml: body,
  });
}

// ---------------------------------------------------------------------------
// 404 Not Found page

export function notFoundPage() {
  const body = `
  <div class="static-page" style="text-align:center;padding:60px 20px;">
    <h1 style="font-size:64px;margin:0 0 8px;color:var(--text);">404</h1>
    <p style="font-size:18px;color:var(--text-muted);margin:0 0 32px;">Page not found</p>
    <p style="margin:0 0 32px;">The page you're looking for doesn't exist or may have been moved.</p>
    <a class="back-link" href="index.html" style="display:inline-block;">&larr; Back to home</a>
  </div>`;

  return layout({
    title: '404 · Page not found',
    lang: 'en',
    assetsPrefix: '',
    bodyHtml: body,
  });
}

// Helpful export for other callers
export { keywordToSlug };
