// 支持的国家/地区清单。lang 字段在后续生成简介（Gemini 阶段）时使用。
// tz: IANA 时区，用于把 observed_at(UTC) 换算成本地日期，作为「一天」的分组依据。
// fetchGeo: 传给 google-trends-now 的 geo 参数；null 表示该 geo 无法直接抓取，
//   需在构建期由其余 geo 聚合得到（WW 即如此：google-trends-now 对 geo='' 返回 0 条）。
export const GEOS = [
  { code: 'WW', name: 'Worldwide',    lang: 'en', tz: 'UTC',                fetchGeo: null },
  { code: 'US', name: 'United States', lang: 'en', tz: 'America/New_York' },
  { code: 'JP', name: 'Japan',         lang: 'ja', tz: 'Asia/Tokyo' },
  { code: 'KR', name: 'South Korea',   lang: 'ko', tz: 'Asia/Seoul' },
  { code: 'IN', name: 'India',         lang: 'en', tz: 'Asia/Kolkata' },
  { code: 'AU', name: 'Australia',     lang: 'en', tz: 'Australia/Sydney' },
  { code: 'CA', name: 'Canada',        lang: 'en', tz: 'America/Toronto' },
  { code: 'DE', name: 'Germany',       lang: 'de', tz: 'Europe/Berlin' },
  { code: 'FR', name: 'France',        lang: 'fr', tz: 'Europe/Paris' },
  { code: 'ES', name: 'Spain',         lang: 'es', tz: 'Europe/Madrid' },
  { code: 'RU', name: 'Russia',        lang: 'ru', tz: 'Europe/Moscow' },
  { code: 'BR', name: 'Brazil',        lang: 'pt-BR', tz: 'America/Sao_Paulo' },
  { code: 'MX', name: 'Mexico',        lang: 'es', tz: 'America/Mexico_City' },
  { code: 'ID', name: 'Indonesia',     lang: 'id', tz: 'Asia/Jakarta' },
  { code: 'TH', name: 'Thailand',      lang: 'th', tz: 'Asia/Bangkok' },
  { code: 'VN', name: 'Vietnam',       lang: 'vi', tz: 'Asia/Ho_Chi_Minh' },
  { code: 'MY', name: 'Malaysia',      lang: 'ms', tz: 'Asia/Kuala_Lumpur' },
  { code: 'SG', name: 'Singapore',     lang: 'en', tz: 'Asia/Singapore' },
  { code: 'HK', name: 'Hong Kong',     lang: 'zh-HK', tz: 'Asia/Hong_Kong' },
  { code: 'PH', name: 'Philippines',   lang: 'en', tz: 'Asia/Manila' },
  { code: 'ZA', name: 'South Africa',  lang: 'en', tz: 'Africa/Johannesburg' },
  { code: 'TR', name: 'Turkey',        lang: 'tr', tz: 'Europe/Istanbul' },
  { code: 'EG', name: 'Egypt',         lang: 'ar', tz: 'Africa/Cairo' },
  { code: 'SA', name: 'Saudi Arabia',  lang: 'ar', tz: 'Asia/Riyadh' },
];

export const GEO_BY_CODE = Object.fromEntries(GEOS.map((g) => [g.code, g]));
