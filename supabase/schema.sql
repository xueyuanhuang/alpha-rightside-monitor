create table if not exists public.alpha_tokens (
  alpha_id text primary key,
  token_id text,
  symbol text not null,
  name text,
  chain_id text,
  chain_name text,
  contract_address text,
  icon_url text,
  price numeric,
  percent_change_24h numeric,
  volume_24h numeric,
  market_cap numeric,
  fdv numeric,
  liquidity numeric,
  holders bigint,
  offline boolean default false,
  fully_delisted boolean default false,
  raw jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.alpha_klines_5m (
  alpha_id text not null references public.alpha_tokens(alpha_id) on delete cascade,
  open_time bigint not null,
  open_time_at timestamptz not null,
  open numeric not null,
  high numeric not null,
  low numeric not null,
  close numeric not null,
  base_volume numeric not null default 0,
  quote_volume numeric not null default 0,
  trade_count integer not null default 0,
  taker_buy_base_volume numeric not null default 0,
  taker_buy_quote_volume numeric not null default 0,
  inserted_at timestamptz not null default now(),
  primary key (alpha_id, open_time)
);

create index if not exists alpha_klines_5m_alpha_time_desc_idx
  on public.alpha_klines_5m (alpha_id, open_time desc);

create index if not exists alpha_klines_5m_time_desc_idx
  on public.alpha_klines_5m (open_time desc);

create table if not exists public.alpha_metrics_current (
  alpha_id text primary key references public.alpha_tokens(alpha_id) on delete cascade,
  computed_at timestamptz not null,
  kline_open_time bigint,
  symbol text not null,
  name text,
  chain_id text,
  chain_name text,
  contract_address text,
  icon_url text,
  price numeric,
  percent_change_24h numeric,
  market_cap numeric,
  fdv numeric,
  liquidity numeric,
  holders bigint,
  ret_15m numeric,
  ret_30m numeric,
  ret_60m numeric,
  vol15_ratio numeric,
  vol60_ratio numeric,
  trades15_ratio numeric,
  quote_vol_60m numeric,
  trades_60m integer,
  range60_ratio numeric,
  volatility_60m numeric,
  signal_level text not null default 'none',
  signal_score numeric not null default 0,
  is_chasing boolean not null default false,
  reasons text[] not null default '{}',
  updated_at timestamptz not null default now()
);

create index if not exists alpha_metrics_current_signal_idx
  on public.alpha_metrics_current (signal_level, signal_score desc);

create index if not exists alpha_metrics_current_chain_idx
  on public.alpha_metrics_current (chain_name);

create table if not exists public.alpha_signal_snapshots (
  id bigserial primary key,
  alpha_id text not null references public.alpha_tokens(alpha_id) on delete cascade,
  computed_at timestamptz not null,
  symbol text not null,
  name text,
  chain_name text,
  contract_address text,
  price numeric,
  signal_level text not null,
  signal_score numeric not null,
  ret_15m numeric,
  ret_30m numeric,
  ret_60m numeric,
  vol15_ratio numeric,
  vol60_ratio numeric,
  trades15_ratio numeric,
  quote_vol_60m numeric,
  trades_60m integer,
  range60_ratio numeric,
  reasons text[] not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists alpha_signal_snapshots_time_idx
  on public.alpha_signal_snapshots (computed_at desc);

create index if not exists alpha_signal_snapshots_alpha_time_idx
  on public.alpha_signal_snapshots (alpha_id, computed_at desc);
