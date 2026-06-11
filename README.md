# Alpha Rightside Monitor

Mobile-first PWA for monitoring Binance Alpha right-side trading signals.

## What It Does

- Stores Binance Alpha token metadata, 5m klines, current computed metrics, and signal snapshots in Supabase.
- Refreshes data in batches through `/api/refresh`.
- Serves a fast PWA dashboard from Cloudflare Pages.
- Shows token contract addresses with one-tap copy for trading.

## Signal Rules

- Watch: `vol60_ratio >= 8`, `ret30 >= 1%`, `ret60 < 8%`
- Entry: `vol60_ratio >= 10`, `ret30 >= 2%`, `ret60 < 8%`
- Strong: `vol60_ratio >= 15`, `ret30 >= 2%`, `ret60 < 8%`, `quote_vol_60m >= 10000`, `trades_60m >= 150`
- Chasing: `ret60 >= 10%` or `ret15 >= 8%`

## Supabase

Run `supabase/schema.sql` in your Supabase SQL editor.

Cloudflare Pages environment variables:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `CRON_SECRET`

Optional variables are defined in `wrangler.toml`.

## Local Development

```bash
npm install
npm run build
npm run dev
```

Create `.dev.vars` for local API testing:

```bash
SUPABASE_URL="https://..."
SUPABASE_SERVICE_ROLE_KEY="..."
CRON_SECRET="local-secret"
```

## Deploy

GitHub Actions deploys to Cloudflare Pages when pushing to `main`. The scheduled collector calls `/api/refresh` in four batches every 5 minutes.
