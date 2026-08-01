# Trendigger

Trendigger is a trend-tracking platform that aggregates and visualizes what people are searching on Google. It offers an hour-by-hour breakdown of popular keywords across 125+ countries and worldwide, making it a handy tool for marketers, journalists, and content creators to monitor viral news.

## How it works

```
[GitHub Actions, every 4h]
   ↓ Fetch Google Trends (Trending Now) for every supported geo via google-trends-now
   ↓ Upsert snapshots into Cloudflare D1 (one row per run × geo × keyword)
   ↓ Generate AI summaries for new keywords (cached forever per keyword × geo)
   ↓ Prune old snapshots, then render static HTML
   ↓ Deploy to Cloudflare Pages

[Visitor] → Cloudflare Pages (static HTML, near-zero DB reads)
            ↳ Dynamic per-date / per-keyword pages served by Pages Functions → D1
```

- **Coverage:** Worldwide aggregation plus all 125 countries Google Trends supports.
- **Cadence:** Collected every 4 hours; the homepage shows the latest run down to the minute, with `4 hours ago` / `8 hours ago` / … / `Yesterday` sections, then older dates.
- **Summaries:** Each keyword gets a short AI-written summary; cards without one stay clean and empty.
- **Cost:** Runs on free tiers (GitHub Actions + Cloudflare Pages + D1).

## Supported geos

Worldwide (`WW`, aggregated at build time) plus 125 countries — see [`src/geos.js`](./src/geos.js).

## Local dev

```bash
npm install
npm run db:init                                   # create local D1 tables

# Run the pipeline
npm run collect                                   # fetch all geos into D1
npm run enrich                                    # generate AI summaries for new keywords
npm run prune                                     # drop snapshots older than the retention window
npm run build                                     # render static site into ./public
npm run serve                                     # preview at http://localhost:5173

# Inspect data
npm run query                                     # today's US trends
node src/query.js JP 2026-08-01                   # other geo/date
npm run query:stats                               # summary
```

Useful flags:

```bash
node collect-trends.js --geos US,JP --with-news 10 --delay-ms 1200
node src/enrich.js --top 50 --limit 200
node src/build.js --days 2 --clean                # full rebuild of the last 2 days
```

### AI provider

`enrich` picks a provider via `AI_PROVIDER`:

- `snippet` (default in CI) — builds summaries from article snippets fetched on the fly. No API key needed.
- `gemini` — uses `gemini-2.5-flash`. Set `GEMINI_API_KEY` (or write it to `./gemini-key`). Free tier is ~10 RPM / 250 RPD; intros are cached per `(keyword, geo)` so re-runs are essentially free. Use `--limit N` to cap spend and `--force` to regenerate.

## Project layout

```
collect-trends.js        # fetch → D1
src/
  geos.js                # 125 countries + WW (lang, timezone, fetchGeo)
  db.js                  # D1 adapter (wrangler --local / --remote)
  enrich.js              # AI summary generation (snippet / gemini / cloudflare)
  providers.js           # intro providers + language labels
  build.js               # static site generator → ./public
  templates.js           # HTML templates (home, geo, keyword, sitemap)
  prune.js               # retention: drop old snapshots
schema.sql               # D1 schema
functions/               # Cloudflare Pages Functions (dynamic date/keyword pages)
public/                  # generated static site
```
