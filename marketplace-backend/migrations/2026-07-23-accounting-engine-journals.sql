-- Accounting Engine — A1: double-entry journal substrate + posting rules + periods.
-- Mirrors docs/ACCOUNTING_ENGINE_STAGE0.md. Additive: gl_entries stays for history;
-- new financial postings go to journal_entries/journal_lines. The Journal Engine is
-- the ONLY writer of financial postings. Service-role-only RLS (engine-internal).
-- Already applied to project omyuqzveegzspeojrqkd.

create table if not exists public.journal_entries (
  id uuid primary key default gen_random_uuid(),
  dealership_id uuid not null,
  entry_date date not null default current_date,
  reference text,
  source text not null,                 -- deal|invoice|expense|po|ro|commission|payroll|bank|manual
  event_name text,
  workflow_instance_id uuid,
  memo text,
  posted boolean not null default true,
  reversal_of uuid references public.journal_entries(id),
  created_by uuid,
  created_at timestamptz not null default now()
);
create index if not exists je_dealer_idx on public.journal_entries (dealership_id, entry_date desc);
create index if not exists je_source_idx on public.journal_entries (dealership_id, source, reference);
alter table public.journal_entries enable row level security;

create table if not exists public.journal_lines (
  id uuid primary key default gen_random_uuid(),
  journal_entry_id uuid not null references public.journal_entries(id) on delete cascade,
  dealership_id uuid not null,
  account_id uuid not null,
  debit numeric(14,2) not null default 0,
  credit numeric(14,2) not null default 0,
  department text,
  ref_deal_id uuid, ref_vehicle_id uuid, ref_contact_id uuid,
  ref_vendor_id uuid, ref_employee_id uuid,
  memo text
);
create index if not exists jl_entry_idx   on public.journal_lines (journal_entry_id);
create index if not exists jl_account_idx on public.journal_lines (dealership_id, account_id);
alter table public.journal_lines enable row level security;

-- Dealership-editable posting rules: one event_name -> N balanced lines.
create table if not exists public.accounting_rules (
  id uuid primary key default gen_random_uuid(),
  dealership_id uuid,                    -- null = global default
  event_name text not null,
  active boolean not null default true,
  lines jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists accounting_rules_key
  on public.accounting_rules (coalesce(dealership_id,'00000000-0000-0000-0000-000000000000'::uuid), event_name);
alter table public.accounting_rules enable row level security;

-- Accounting periods: open -> manager_approved -> controller_approved -> closed -> locked.
create table if not exists public.accounting_periods (
  id uuid primary key default gen_random_uuid(),
  dealership_id uuid not null,
  period text not null,                 -- 'YYYY-MM'
  status text not null default 'open',
  approvals jsonb not null default '{}',
  locked_at timestamptz, locked_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists accounting_periods_key on public.accounting_periods (dealership_id, period);
alter table public.accounting_periods enable row level security;

-- Default posting rules (dealership_id null). `source` = amount token the generator
-- computes from context. Debits must equal credits per event.
insert into public.accounting_rules (dealership_id, event_name, lines) values
  (null, 'vehicle_delivered', '[
    {"account_key":"accounts_receivable","side":"debit","source":"ar_total","desc":"Amount due from sale"},
    {"account_key":"vehicle_sales","side":"credit","source":"selling_price","desc":"Vehicle sales revenue"},
    {"account_key":"fni_income","side":"credit","source":"fni_gross","desc":"F&I income"},
    {"account_key":"tax_collected","side":"credit","source":"tax","desc":"Sales tax payable"},
    {"account_key":"cogs","side":"debit","source":"cost","desc":"Cost of goods sold"},
    {"account_key":"inventory","side":"credit","source":"cost","desc":"Relieve inventory"}
  ]'::jsonb),
  (null, 'commission_calculated', '[
    {"account_key":"commission_expense","side":"debit","source":"commission_total","desc":"Commission expense"},
    {"account_key":"commission_payable","side":"credit","source":"commission_total","desc":"Commission payable"}
  ]'::jsonb),
  (null, 'commission_paid', '[
    {"account_key":"commission_payable","side":"debit","source":"commission_total","desc":"Clear commission payable"},
    {"account_key":"cash","side":"credit","source":"commission_total","desc":"Cash paid"}
  ]'::jsonb),
  (null, 'deposit_received', '[
    {"account_key":"cash","side":"debit","source":"deposit_amount","desc":"Cash received"},
    {"account_key":"customer_deposits","side":"credit","source":"deposit_amount","desc":"Customer deposit liability"}
  ]'::jsonb)
on conflict (coalesce(dealership_id,'00000000-0000-0000-0000-000000000000'::uuid), event_name) do nothing;
