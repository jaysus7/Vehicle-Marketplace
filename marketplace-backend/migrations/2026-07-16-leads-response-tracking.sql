-- Speed-to-lead tracking: when a lead was first answered, and by whom.
-- Powers the live "time to answer" clock on the Leads worklist and the
-- response-time reporting/insights.
alter table public.leads
  add column if not exists responded_at timestamptz,
  add column if not exists responded_by uuid references public.profiles(id) on delete set null;

create index if not exists idx_leads_dealership_created on public.leads (dealership_id, created_at desc);
create index if not exists idx_leads_dealership_responded on public.leads (dealership_id, responded_at);
