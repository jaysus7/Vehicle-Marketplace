-- Cleanup / get-ready: delivery schedule + a checklist of what the car needs +
-- the attached salesperson and originating deal (populated by the FNI approve flow).
alter table public.recon
  add column if not exists delivery_at    timestamptz,
  add column if not exists checklist      jsonb not null default '[]'::jsonb,
  add column if not exists salesperson_id uuid references public.profiles(id) on delete set null,
  add column if not exists fni_products   text,
  add column if not exists deal_id        uuid;

create index if not exists idx_recon_dealership_delivery on public.recon (dealership_id, delivery_at);
