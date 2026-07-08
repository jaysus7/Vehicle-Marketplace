-- Cost controls for MarketCheck (metered) + AI usage.
--
-- Three pieces:
--   1. market_cache — shared cache of MarketCheck lookups keyed by vehicle
--      signature, so the scan / appraisal / price report reuse one live call for
--      MARKET_CACHE_DAYS and identical trims across the lot dedupe to one call.
--   2. api_usage — per-dealership monthly counters for soft quotas (fall back to
--      cache when exceeded). A sentinel dealership_id of all-zeros holds the
--      platform-wide monthly totals for the global budget kill-switch.
--   3. bump_usage() — atomic increment so parallel scans count correctly.
--
-- All three are written only by the backend service role, so RLS is enabled with
-- no public policies. The backend fails open if this migration hasn't run yet.

create table if not exists market_cache (
  signature   text primary key,          -- e.g. 'ca|chevrolet|silverado 1500|2019|lt'
  data        jsonb not null,
  fetched_at  timestamptz not null default now()
);
create index if not exists market_cache_fetched_idx on market_cache (fetched_at);

create table if not exists api_usage (
  dealership_id     uuid not null,        -- all-zeros sentinel = platform-wide totals
  period            text not null,        -- 'YYYY-MM' (UTC)
  marketcheck_calls integer not null default 0,
  ai_calls          integer not null default 0,
  updated_at        timestamptz not null default now(),
  primary key (dealership_id, period)
);

-- Atomic upsert-increment so the parallel scan (CONCURRENCY=3) counts accurately.
create or replace function bump_usage(p_dealership uuid, p_period text, p_mc integer, p_ai integer)
returns void language sql as $$
  insert into api_usage (dealership_id, period, marketcheck_calls, ai_calls, updated_at)
  values (p_dealership, p_period, greatest(p_mc, 0), greatest(p_ai, 0), now())
  on conflict (dealership_id, period) do update
    set marketcheck_calls = api_usage.marketcheck_calls + greatest(p_mc, 0),
        ai_calls          = api_usage.ai_calls + greatest(p_ai, 0),
        updated_at        = now();
$$;

alter table market_cache enable row level security;
alter table api_usage   enable row level security;
