-- Vehicle history (Carfax VHR / lien / valuation) attached to a vehicle, deal or
-- customer, so a pulled report is stored and re-viewable. Files live in the
-- vehicle-pdfs bucket under a history/ prefix; external_url holds the Carfax link.
create table if not exists vehicle_history_reports (
  id             uuid primary key default gen_random_uuid(),
  dealership_id  uuid not null references dealerships(id) on delete cascade,
  inventory_id   uuid references inventory(id) on delete set null,
  contact_id     uuid references contacts(id) on delete set null,
  deal_id        uuid references deals(id) on delete set null,
  vin            text,
  provider       text default 'manual',   -- carfax | manual
  report_type    text default 'vhr',      -- vhr | lien | valuation | other
  external_url   text,
  file_url       text,
  file_path      text,
  summary        jsonb,
  pulled_by      uuid references profiles(id) on delete set null,
  created_at     timestamptz default now()
);
create index if not exists vehicle_history_dealer_idx on vehicle_history_reports (dealership_id, vin);
create index if not exists vehicle_history_inv_idx on vehicle_history_reports (inventory_id);
alter table vehicle_history_reports enable row level security;
