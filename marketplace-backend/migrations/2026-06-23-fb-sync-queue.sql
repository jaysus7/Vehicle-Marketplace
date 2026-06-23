-- Facebook Marketplace auto-sync queue
-- Run this once in the Supabase SQL editor (or via psql) before deploying the
-- FB auto-sold/delete code. Safe to re-run: every statement is guarded.
--
-- When a vehicle is sold or deleted on MarketSync, we flag its listing so the
-- browser extension can pick it up and either mark the Facebook listing "Sold"
-- or delete it from Facebook Marketplace (FB has no server-side API, so the
-- extension must do this client-side while the user is logged into Facebook).

-- 'sold' | 'delete' | null. Null = nothing pending for Facebook.
alter table public.listings
  add column if not exists fb_sync_action text;

-- Set once the extension has successfully performed the action on Facebook.
-- Null + non-null fb_sync_action = still queued for the extension to process.
alter table public.listings
  add column if not exists fb_synced_at timestamptz;

-- How many times the extension has tried (so we can stop retrying a listing
-- whose FB page is gone / button can't be found, instead of looping forever).
alter table public.listings
  add column if not exists fb_sync_attempts int not null default 0;

-- Fast lookup for the extension's "what's pending for me?" poll.
create index if not exists listings_fb_sync_pending_idx
  on public.listings (posted_by)
  where fb_sync_action is not null and fb_synced_at is null;
