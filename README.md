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

Required GitHub repository secrets:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`
- `CRON_SECRET`

Required Cloudflare Pages secrets:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `CRON_SECRET`

Set them with:

```bash
printf "%s" "$CLOUDFLARE_ACCOUNT_ID" | gh secret set CLOUDFLARE_ACCOUNT_ID --repo xueyuanhuang/alpha-rightside-monitor
printf "%s" "$CLOUDFLARE_API_TOKEN" | gh secret set CLOUDFLARE_API_TOKEN --repo xueyuanhuang/alpha-rightside-monitor
printf "%s" "$CRON_SECRET" | gh secret set CRON_SECRET --repo xueyuanhuang/alpha-rightside-monitor

printf "%s" "$SUPABASE_URL" | wrangler pages secret put SUPABASE_URL --project-name=alpha-rightside-monitor
printf "%s" "$SUPABASE_SERVICE_ROLE_KEY" | wrangler pages secret put SUPABASE_SERVICE_ROLE_KEY --project-name=alpha-rightside-monitor
printf "%s" "$CRON_SECRET" | wrangler pages secret put CRON_SECRET --project-name=alpha-rightside-monitor
```

After Supabase secrets are configured, seed data in four batches:

```bash
curl "https://alpha-rightside-monitor.pages.dev/api/refresh?key=$CRON_SECRET&offset=0&limit=100&bootstrap=1"
curl "https://alpha-rightside-monitor.pages.dev/api/refresh?key=$CRON_SECRET&offset=100&limit=100&bootstrap=1"
curl "https://alpha-rightside-monitor.pages.dev/api/refresh?key=$CRON_SECRET&offset=200&limit=100&bootstrap=1"
curl "https://alpha-rightside-monitor.pages.dev/api/refresh?key=$CRON_SECRET&offset=300&limit=100&bootstrap=1"
```
