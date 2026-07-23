-- Workflow Engine — Stage 1 (schema only). Mirrors docs/WORKFLOW_ENGINE_STAGE0.md.
-- These tables are engine-internal: written exclusively by the backend service role,
-- which bypasses RLS. RLS is enabled with NO policies (service-role-only) so nothing
-- is reachable by direct client access. This is the deliberate default for the
-- workflow spine (contrast recon.sql, which adds read/write policies for direct
-- dealer client access). Already applied to project omyuqzveegzspeojrqkd.

-- 1.1 events — the single unified activity spine (also powers the Timeline view)
create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  dealership_id uuid not null,
  event_name text not null,            -- customer.created, deal.status_changed, deposit.paid
  summary text,                        -- human line for the timeline screen
  entity_type text not null,           -- customer|vehicle|deal|task|appraisal|...
  entity_id uuid not null,
  from_state text,
  to_state text,
  department text,
  payload jsonb not null default '{}',
  created_by uuid,
  created_at timestamptz not null default now()
);
create index if not exists events_entity_idx on public.events (dealership_id, entity_type, entity_id, created_at desc);
create index if not exists events_name_idx   on public.events (dealership_id, event_name, created_at desc);
alter table public.events enable row level security;

-- 1.2 workflow_templates / workflow_steps / workflow_instances
create table if not exists public.workflow_templates (
  id uuid primary key default gen_random_uuid(),
  dealership_id uuid,                   -- null = global default seed
  name text not null,
  target_entity text not null,          -- deal|vehicle|customer
  trigger_event text not null,          -- e.g. deal.status_changed:sold
  active boolean not null default true,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.workflow_templates enable row level security;

create table if not exists public.workflow_steps (
  id uuid primary key default gen_random_uuid(),
  workflow_template_id uuid not null references public.workflow_templates(id) on delete cascade,
  step_order int not null,
  name text not null,
  action_type text not null,            -- create_task|update_state|post_ledger|post_commission|add_timeline|send_notification|send_email|send_sms|request_approval|create_exception|wait|system_vin_decode|system_carfax
  department text,
  config jsonb not null default '{}',
  depends_on int[] default '{}',        -- step_orders that must complete first
  required boolean not null default true
);
create index if not exists workflow_steps_tpl_idx on public.workflow_steps (workflow_template_id, step_order);
alter table public.workflow_steps enable row level security;

create table if not exists public.workflow_instances (
  id uuid primary key default gen_random_uuid(),
  dealership_id uuid not null,
  workflow_template_id uuid not null references public.workflow_templates(id),
  entity_type text not null,
  entity_id uuid not null,
  status text not null default 'running',   -- running|completed|cancelled
  current_step int not null default 0,
  context jsonb not null default '{}',
  started_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists wf_instances_entity_idx on public.workflow_instances (dealership_id, entity_type, entity_id);
create unique index if not exists wf_instances_dedupe on public.workflow_instances (workflow_template_id, entity_type, entity_id) where status = 'running';
alter table public.workflow_instances enable row level security;

-- 1.3 task_dependencies / exceptions / state_ownership
create table if not exists public.task_dependencies (
  task_id uuid not null references public.dealer_tasks(id) on delete cascade,
  depends_on_task_id uuid not null references public.dealer_tasks(id) on delete cascade,
  required_status text not null default 'completed',
  primary key (task_id, depends_on_task_id)
);
alter table public.task_dependencies enable row level security;

create table if not exists public.exceptions (
  id uuid primary key default gen_random_uuid(),
  dealership_id uuid not null,
  kind text not null,                   -- recon_stalled|lead_unanswered|sold_not_delivered|task_overdue|approval_waiting
  entity_type text not null,
  entity_id uuid not null,
  department text,
  severity text not null default 'medium',   -- low|medium|high
  description text,
  status text not null default 'open',       -- open|acknowledged|resolved
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid
);
create index if not exists exceptions_open_idx on public.exceptions (dealership_id, status, severity);
create unique index if not exists exceptions_dedupe on public.exceptions (dealership_id, kind, entity_type, entity_id) where status <> 'resolved';
alter table public.exceptions enable row level security;

create table if not exists public.state_ownership (
  id uuid primary key default gen_random_uuid(),
  dealership_id uuid,                    -- null = global default
  entity_type text not null,
  state text not null,
  department text not null,
  responsible_role text,
  notify_roles text[] default '{}',
  can_complete_roles text[] default '{}',
  can_override_roles text[] default '{}'
);
create unique index if not exists state_ownership_key on public.state_ownership (coalesce(dealership_id,'00000000-0000-0000-0000-000000000000'::uuid), entity_type, state);
alter table public.state_ownership enable row level security;

-- 1.4 shared vendors table (expenses + body-shop/sublet task assignment).
-- expense_vendors is left intact for the expense module; a later stage will
-- repoint expenses at this table and deprecate expense_vendors.
create table if not exists public.vendors (
  id uuid primary key default gen_random_uuid(),
  dealership_id uuid not null,
  name text not null,
  vendor_type text not null default 'expense',   -- expense|body_shop|sublet|both
  contact text,
  phone text,
  email text,
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists vendors_dealer_idx on public.vendors (dealership_id, active);
alter table public.vendors enable row level security;

-- 1.5 extend the universal task table + give profiles a department
alter table public.dealer_tasks
  add column if not exists workflow_instance_id uuid,
  add column if not exists workflow_step_id uuid,
  add column if not exists department text,
  add column if not exists assigned_vendor_id uuid,   -- e.g. body shop
  add column if not exists blocked_reason text;
create index if not exists dealer_tasks_wf_idx on public.dealer_tasks (dealership_id, workflow_instance_id);

alter table public.profiles add column if not exists department text;

-- 1.6a seed the three global-default workflow templates
do $$
declare tpl_id uuid;
begin
  if not exists (select 1 from public.workflow_templates where dealership_id is null and name='Sold Vehicle Delivery') then
    insert into public.workflow_templates(dealership_id,name,target_entity,trigger_event)
    values(null,'Sold Vehicle Delivery','deal','deal.status_changed:sold') returning id into tpl_id;
    insert into public.workflow_steps(workflow_template_id,step_order,name,action_type,department,config,depends_on) values
      (tpl_id,1,'PDI check','create_task','Service','{"kind":"Safety","title":"PDI check"}','{}'),
      (tpl_id,2,'Safety','create_task','Service','{"kind":"Safety","title":"Safety inspection"}','{}'),
      (tpl_id,3,'Detail','create_task','Cleanup','{"kind":"Detail","title":"Detail vehicle"}','{}'),
      (tpl_id,4,'Fuel','create_task','Cleanup','{"kind":"Fuel","title":"Fuel vehicle"}','{}'),
      (tpl_id,5,'Photos','create_task','Marketing','{"kind":"Photos","title":"Delivery photos"}','{}'),
      (tpl_id,6,'Install plates','create_task','Sales','{"kind":"Plates","title":"Install licence plates"}','{}'),
      (tpl_id,7,'Post revenue','post_ledger','Accounting','{}','{}'),
      (tpl_id,8,'Post commission','post_commission','Accounting','{}','{}'),
      (tpl_id,9,'Schedule delivery','create_task','Sales','{"kind":"Deliver","title":"Schedule & confirm delivery"}','{1,2,3,6}'),
      (tpl_id,10,'Review request','send_sms','CRM','{}','{9}');
  end if;

  if not exists (select 1 from public.workflow_templates where dealership_id is null and name='Trade Acquisition') then
    insert into public.workflow_templates(dealership_id,name,target_entity,trigger_event)
    values(null,'Trade Acquisition','vehicle','trade.approved') returning id into tpl_id;
    insert into public.workflow_steps(workflow_template_id,step_order,name,action_type,department,config,depends_on) values
      (tpl_id,1,'Create inventory unit','update_state',null,'{"to_state":"won"}','{}'),
      (tpl_id,2,'VIN decode','system_vin_decode','Sales','{}','{}'),
      (tpl_id,3,'Carfax','system_carfax','Sales','{}','{}'),
      (tpl_id,4,'Inspection','create_task','Service','{"kind":"Safety","title":"Incoming inspection"}','{}'),
      (tpl_id,5,'Safety','create_task','Service','{"kind":"Safety","title":"Safety"}','{4}'),
      (tpl_id,6,'Recon','create_task','Service','{"kind":"Parts","title":"Recon"}','{5}'),
      (tpl_id,7,'Photos','create_task','Marketing','{"kind":"Photos","title":"Photograph"}','{6}'),
      (tpl_id,8,'List live','update_state',null,'{"to_state":"live"}','{7}');
  end if;

  if not exists (select 1 from public.workflow_templates where dealership_id is null and name='New Lead Follow-Up') then
    insert into public.workflow_templates(dealership_id,name,target_entity,trigger_event)
    values(null,'New Lead Follow-Up','customer','lead.created') returning id into tpl_id;
    insert into public.workflow_steps(workflow_template_id,step_order,name,action_type,department,config,depends_on) values
      (tpl_id,1,'Notify salesperson','send_notification','Sales','{}','{}'),
      (tpl_id,2,'5-min SLA timer','wait',null,'{"minutes":5}','{}'),
      (tpl_id,3,'Escalate if silent','create_exception','Sales Manager','{"kind":"lead_unanswered","unless_event":"customer.contacted"}','{}'),
      (tpl_id,4,'Follow-up task','create_task','Sales','{"kind":"Call","title":"Call new lead"}','{}');
  end if;
end $$;

-- 1.6b seed global-default department ownership per entity state
insert into public.state_ownership
  (dealership_id, entity_type, state, department, responsible_role, can_override_roles)
values
  (null,'deal','open','Sales','Salesperson','{dealer_admin,manager}'),
  (null,'deal','negotiating','Sales','Salesperson','{dealer_admin,manager}'),
  (null,'deal','pending_approval','Sales Manager','Manager','{dealer_admin,manager}'),
  (null,'deal','approved','F&I','F&I Manager','{dealer_admin,manager}'),
  (null,'deal','fni','F&I','F&I Manager','{dealer_admin,manager}'),
  (null,'deal','deposit_received','Accounting','Accounting','{dealer_admin,manager}'),
  (null,'deal','ready','Sales','Salesperson','{dealer_admin,manager}'),
  (null,'deal','delivered','Accounting','Accounting','{dealer_admin,manager}'),
  (null,'deal','funded','Accounting','Accounting','{dealer_admin,manager}'),
  (null,'deal','closed','Accounting','Accounting','{dealer_admin,manager}'),
  (null,'vehicle','appraisal','Sales','Salesperson','{dealer_admin,manager}'),
  (null,'vehicle','pdi','Service','Technician','{dealer_admin,manager}'),
  (null,'vehicle','safety','Service','Technician','{dealer_admin,manager}'),
  (null,'vehicle','recon','Service','Service Manager','{dealer_admin,manager}'),
  (null,'vehicle','detail','Cleanup','Detail Dept','{dealer_admin,manager}'),
  (null,'vehicle','body_shop','Vendor','Body Shop Vendor','{dealer_admin,manager}'),
  (null,'vehicle','photos','Marketing','Marketing','{dealer_admin,manager}'),
  (null,'vehicle','live','Sales','Inventory Manager','{dealer_admin,manager}'),
  (null,'vehicle','reserved','Sales','Salesperson','{dealer_admin,manager}'),
  (null,'vehicle','sold','Sales','Salesperson','{dealer_admin,manager}'),
  (null,'vehicle','delivered','Sales','Salesperson','{dealer_admin,manager}'),
  (null,'customer','lead','Sales','Salesperson','{dealer_admin,manager}'),
  (null,'customer','contacted','Sales','Salesperson','{dealer_admin,manager}'),
  (null,'customer','appointment','Sales','Salesperson','{dealer_admin,manager}'),
  (null,'customer','showed','Sales','Salesperson','{dealer_admin,manager}'),
  (null,'customer','negotiating','Sales','Salesperson','{dealer_admin,manager}'),
  (null,'customer','sold','Sales','Salesperson','{dealer_admin,manager}'),
  (null,'customer','delivered','Sales','Salesperson','{dealer_admin,manager}'),
  (null,'customer','owner','CRM','Automation','{dealer_admin,manager}'),
  (null,'customer','equity_candidate','CRM','Automation','{dealer_admin,manager}')
on conflict (coalesce(dealership_id,'00000000-0000-0000-0000-000000000000'::uuid), entity_type, state) do nothing;
