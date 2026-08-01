# Trendigger

A historical Google Trends explorer with AI-generated summaries for each trending keyword.

> **Status:** Stage 1 — local fetch + parse demo. No DB, no AI, no static site yet.

## Architecture (planned)

```
[Cloudflare Workers Cron, every 4h]
   ↓ Fetch Google Trends RSS for each geo
   ↓ Upsert into D1 (one row per (date, geo, keyword))
   ↓ Generate intro via Gemini API for new keywords (cached forever in D1)
   ↓ Render static HTML pages
   ↓ Deploy to Cloudflare Pages

[User] → Cloudflare Pages (pure static, zero DB reads)
```

- **Update cadence:** every 4h
- **History granularity:** 1 row per day per (geo, keyword), retained for 365 days
- **Cost:** $0/month on free tiers (CF Pages + D1 + Gemini Flash + Workers Cron)

## Stage 1: local demo

```bash
npm install
npm run demo            # USA, pretty-printed
npm run demo:json       # USA, JSON
GEO=JP npm run demo     # other countries
```

Sample output:

```
🔥 Google Trends — United States (US, lang=en)
   Fetched at: 2026-04-26T05:11:00.000Z
   10 trending topics

# 1  fifth third bank   [500+ searches · started 2h ago]
     Trend breakdown (related news):
       • Fifth Third Bancorp Annual Meeting: ...  — Yahoo Finance
       • ...
```

## Supported geos (planned)

US, JP, KR, IN, AU, CA, DE, FR, ES, RU, BR, MX, ID, TH, VN, MY, SG, HK, PH, ZA, TR, EG, SA — see [`src/geos.js`](./src/geos.js).

## Roadmap

- [x] Stage 1 — RSS fetch & parse, console demo
- [x] Stage 2 — D1 schema + ingest + daily upsert + query tool
- [x] Stage 3 — Gemini-based intro generation (per-geo language, permanent cache)
- [ ] Stage 4 — Static site generator (geo pages, history pages, keyword detail)
- [ ] Stage 5 — Cloudflare Workers Cron Trigger + Pages deploy

## Local dev cheatsheet

```bash
# One-time setup
npm install
npm run db:init                                  # create local D1 tables
echo "YOUR_GEMINI_KEY" > gemini-key              # or export GEMINI_API_KEY

# Run the pipeline
npm run ingest                                   # fetch all geos into D1
npm run enrich                                   # generate intros for today's new keywords
npm run query                                    # view US today
node src/query.js JP 2026-04-26                 # other geo/date
npm run query:stats                              # summary
```

### Gemini quota notes
- Free tier of `gemini-2.5-flash`: ~10 RPM, 250 RPD.
- `src/gemini.js` enforces a 6.5s gap between requests; `enrich.js` uses concurrency=2 by default.
- Intros are cached per `(keyword, geo)` in `keyword_intro` table — re-running enrich on the same day is essentially free.
- Use `--limit N` to cap spend per run; `--force` to regenerate.
