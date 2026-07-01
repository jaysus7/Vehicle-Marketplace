-- AI activity log: records every enrichment run so dealers can see what AI found
create table if not exists ai_activity (
  id            uuid primary key default gen_random_uuid(),
  dealership_id uuid not null references dealerships(id) on delete cascade,
  inventory_id  uuid references inventory(id) on delete set null,
  actor_id      uuid references profiles(id) on delete set null,
  vehicle_label text,                          -- "2022 Honda Civic Sport"
  warnings      text[],                        -- missing field alerts
  price_flagged boolean default false,
  price_pct_diff numeric(6,1),                 -- % above/below median (+ = over, - = under)
  price_median  numeric(12,2),
  copy_generated boolean default false,
  created_at    timestamptz default now()
);

create index on ai_activity (dealership_id, created_at desc);

alter table ai_activity enable row level security;

-- Dealer members can read their own dealership's activity
create policy "ai_activity_read" on ai_activity
  for select using (
    dealership_id in (
      select dealership_id from profiles where id = auth.uid()
    )
  );
