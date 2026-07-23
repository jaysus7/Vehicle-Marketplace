# MarketSync Workflow Engine — Stage 0 Blueprint

> **Status: DESIGN ONLY. Nothing in here has been applied.** No tables created, no
> code changed. This is the package to review *before* Stage 1. Approve it and the
> migrations below get applied one stage at a time, each validated.

---

## 0. The design law (governs every future feature)

> **Every piece of information has exactly one owner. Every action has exactly one
> responsible party. Every workflow has exactly one current state. Every screen
> answers: What happened? What is happening now? What happens next?**

Everything below serves that law.

---

## 1. Architecture spine

```
STATE CHANGE  →  EVENT  →  WORKFLOW  →  SYSTEM ACTIONS ─┬─ update_state
(entity owns   (one log)  (reacts to   (no human)       ├─ post_ledger
 its status)              transitions)                   ├─ post_commission
                                                         ├─ add_timeline
                                                         ├─ notify
                                                         └─ create_exception
                                        HUMAN ACTIONS ──── create_task → dependencies
```

Three non-negotiable principles:

1. **State machine first.** Every core entity always has exactly one state. The
   engine reacts to *transitions*, it does not "run scripts."
2. **Single Source of Truth.** State lives only on the owning table. Workflow
   tables **observe** state; they never copy it.
3. **System Actions layer.** Not every event makes a task. `deposit.paid` posts
   accounting + commission + CRM + vehicle state + timeline + notification with
   zero human tasks.

---

## 2. What already exists (do NOT rebuild)

| Concept | Table today | Reuse plan |
|---|---|---|
| Dealership | `dealerships` | as-is |
| Employees | `profiles` (role) | add `department` |
| Customers | `contacts` (`status`) | extend status ladder |
| Vehicles | `inventory` (`status`) + `recon` (`stage`) | compose lifecycle |
| Deals | `deals` (`deal_status`) | extend status ladder |
| Tasks | `dealer_tasks` (`status`) | **becomes the universal task table** |
| Sales follow-ups | `crm_tasks` | keep + bridge (not merged) |
| Accounting | `gl_entries`, `gl_accounts`, `expenses` | system-action target |
| Communications | `communications` | feeds timeline |
| Audit | `audit_log` | manager-override log |
| Recon/Cleanup | `recon` | already a vehicle sub-state machine |
| Automation | `automated_campaigns`, `drip_sends`, `scheduled_messages` | become workflow actions |

**Already-running hard-coded workflow** (proof the model fits): a desked deal
already fires `ensureDealTasks` + `ensureGetReadyCard` + recon↔task two-way sync.
These become the first templates the engine formalizes.

---

## 3. State model (the four ladders) + SSOT

State lives **only** in the owning column. New allowed values are added to the
existing column — no new "status" columns on workflow tables.

### Customer — SSOT `contacts.status`
`lead → contacted → appointment → showed → negotiating → sold → delivered → owner → equity_candidate`
*Back-map:* today's `uncontacted`→`lead`, existing `contacted/appointment/sold/delivered` keep; add `showed, negotiating, owner, equity_candidate`.

### Vehicle — SSOT `inventory.status` (acquisition/sale) + `recon.stage` (get-ready sub-states)
`incoming → appraisal → won → awaiting_arrival → arrived → pdi → safety → recon → photos → live → reserved → sold → delivered → archived`
*Design note:* `inventory.status` owns the top-level lifecycle; `recon.stage`
(arrived→mechanical→parts→detail→photos→frontline) is the get-ready detail. We add
a computed **`inventory.lifecycle_state`** helper that composes the two so a page
can show one word. SSOT stays split by responsibility, never duplicated.

### Deal — SSOT `deals.deal_status`
`open → negotiating → pending_approval → approved → deposit_received → fni → ready → delivered → funded → closed`
*Back-map:* `working`→`open`, `pending_credit`→`pending_approval`, keep `sold/fni/delivered`; add the rest.

### Task — SSOT `dealer_tasks.status`
`created → assigned → started → waiting → blocked → completed`
*Back-map:* `todo`→`created/assigned`, `in_progress`→`started`, keep `blocked`, `done`→`completed`.

Every transition writes one `events` row (`from_state`, `to_state`) — that row **is**
the timeline entry.

---

## 4. Department Ownership Model (new)

Each state knows its **department, responsible party, who's notified, who can
complete, who can override.** Stored in `state_ownership` (dealership-overridable,
seeded with these defaults):

| Entity | State | Department | Responsible role |
|---|---|---|---|
| Deal | open / negotiating | Sales | Salesperson |
| Deal | pending_approval | Sales Manager | Manager |
| Deal | approved / fni | F&I | F&I Manager |
| Deal | deposit_received | Accounting | Accounting |
| Deal | delivered / funded / closed | Accounting | Accounting |
| Vehicle | appraisal | Sales | Salesperson/Appraiser |
| Vehicle | pdi / safety | Service | Service Mgr / Technician |
| Vehicle | recon | Service | Service Manager |
| Vehicle | detail (recon sub) | Cleanup | Detail Dept |
| Vehicle | body_shop | Vendor | Body Shop vendor |
| Vehicle | photos | Marketing | Marketing |
| Vehicle | live | Sales | Inventory Manager |
| Vehicle | reserved / sold / delivery | Sales | Salesperson |
| Customer | lead → negotiating | Sales | Salesperson |
| Customer | owner / equity_candidate | CRM | Automation |

**Departments:** Sales · Sales Manager · F&I · Service · Cleanup · Marketing ·
Accounting · CRM · Vendor. (Maps to the staff roles already built: FNI, SERVICE,
ACCOUNTING, CLEANUP + manager/admin.)

Result: every state auto-knows who owns it, who to notify, who can complete it,
and who can override — no guessing.

---

## 5. New tables (SQL — for review, NOT applied)

All follow the project pattern: `enable row level security` with no policies
(service-role only). Each explained before it's ever run.

### 5.1 `events` — the one unified activity spine / timeline
*Why:* single log for everything (SSOT rule #2 for history). Machine name for the
engine + human `summary` for the timeline screen. Replaces scattered activity logs.
```sql
create table public.events (
  id uuid primary key default gen_random_uuid(),
  dealership_id uuid not null,
  event_name text not null,            -- customer.created, deal.status_changed, deposit.paid
  summary text,                        -- "Deposit paid — $500"
  entity_type text not null,           -- customer|vehicle|deal|task|appraisal|...
  entity_id uuid not null,
  from_state text, to_state text,      -- populated on state transitions
  department text,                     -- department the event belongs to
  payload jsonb not null default '{}',
  created_by uuid,
  created_at timestamptz not null default now()
);
create index events_entity_idx  on public.events (dealership_id, entity_type, entity_id, created_at desc);
create index events_name_idx    on public.events (dealership_id, event_name, created_at desc);
```

### 5.2 `workflow_templates` — process blueprints
```sql
create table public.workflow_templates (
  id uuid primary key default gen_random_uuid(),
  dealership_id uuid,                   -- null = global default seed
  name text not null,
  target_entity text not null,         -- deal|vehicle|customer
  trigger_event text not null,         -- deal.status_changed:sold
  active boolean not null default true,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

### 5.3 `workflow_steps` — ordered actions in a template
*Why separate table:* lets a template editor reorder/edit steps later.
`action_type` covers both system actions and human tasks.
```sql
create table public.workflow_steps (
  id uuid primary key default gen_random_uuid(),
  workflow_template_id uuid not null references public.workflow_templates(id) on delete cascade,
  step_order int not null,
  name text not null,
  action_type text not null,           -- create_task | update_state | post_ledger | post_commission | add_timeline | send_notification | send_email | send_sms | request_approval | create_exception
  department text,                     -- owner of the resulting task/action
  config jsonb not null default '{}',  -- kind, title, due offset, template body, target state, etc.
  depends_on int[] default '{}',       -- step_orders that must complete first (task deps)
  required boolean not null default true
);
create index workflow_steps_tpl_idx on public.workflow_steps (workflow_template_id, step_order);
```

### 5.4 `workflow_instances` — a running workflow on one record (observes state, never stores it)
```sql
create table public.workflow_instances (
  id uuid primary key default gen_random_uuid(),
  dealership_id uuid not null,
  workflow_template_id uuid not null references public.workflow_templates(id),
  entity_type text not null,
  entity_id uuid not null,
  status text not null default 'running',   -- running | completed | cancelled
  current_step int not null default 0,
  context jsonb not null default '{}',
  started_at timestamptz not null default now(),
  completed_at timestamptz
);
create index wf_instances_entity_idx on public.workflow_instances (dealership_id, entity_type, entity_id);
create unique index wf_instances_dedupe on public.workflow_instances (workflow_template_id, entity_type, entity_id) where status = 'running';
```

### 5.5 `dealer_tasks` — EXTEND (universal task table; do not create a new `tasks`)
*Already has:* status, kind, assignee_id, assignee_name, priority, due_date,
completed_at, vin, stock_number, inventory_id, contact_id, deal_id, photos, events.
*Add:*
```sql
alter table public.dealer_tasks
  add column if not exists workflow_instance_id uuid,
  add column if not exists workflow_step_id uuid,
  add column if not exists department text,
  add column if not exists assigned_vendor_id uuid,   -- e.g. body shop
  add column if not exists blocked_reason text;
create index if not exists dealer_tasks_wf_idx on public.dealer_tasks (dealership_id, workflow_instance_id);
```

### 5.6 `task_dependencies` — hard ordering
```sql
create table public.task_dependencies (
  task_id uuid not null references public.dealer_tasks(id) on delete cascade,
  depends_on_task_id uuid not null references public.dealer_tasks(id) on delete cascade,
  required_status text not null default 'completed',
  primary key (task_id, depends_on_task_id)
);
```
Enforcement: a task cannot leave `created` for `completed` (or a deal cannot reach
`delivered`) while any dependency is unmet — checked server-side.

### 5.7 `exceptions` — the manager problem dashboard
```sql
create table public.exceptions (
  id uuid primary key default gen_random_uuid(),
  dealership_id uuid not null,
  kind text not null,                  -- recon_stalled | lead_unanswered | sold_not_delivered | task_overdue | approval_waiting
  entity_type text not null,
  entity_id uuid not null,
  department text,                     -- who should fix it
  severity text not null default 'medium',   -- low | medium | high
  description text,
  status text not null default 'open',       -- open | acknowledged | resolved
  created_at timestamptz not null default now(),
  resolved_at timestamptz, resolved_by uuid
);
create index exceptions_open_idx on public.exceptions (dealership_id, status, severity);
create unique index exceptions_dedupe on public.exceptions (dealership_id, kind, entity_type, entity_id) where status <> 'resolved';
```

### 5.8 `state_ownership` — department model config
```sql
create table public.state_ownership (
  id uuid primary key default gen_random_uuid(),
  dealership_id uuid,                   -- null = global default
  entity_type text not null,
  state text not null,
  department text not null,
  responsible_role text,
  notify_roles text[] default '{}',
  can_complete_roles text[] default '{}',
  can_override_roles text[] default '{}'
);
create unique index state_ownership_key on public.state_ownership (coalesce(dealership_id,'00000000-0000-0000-0000-000000000000'::uuid), entity_type, state);
```

### 5.9 `profiles` — EXTEND
```sql
alter table public.profiles add column if not exists department text;
```

**Manager override:** no new table — overrides write to the existing `audit_log`
(`action='workflow_override'`, actor, reason, timestamp, entity ref). Required
fields: approver, reason, timestamp — enforced server-side.

**Timeline:** no new table — the timeline screen is a **view over `events`** for an
entity plus its related entities (a customer's timeline merges the customer + its
deal + its vehicle events). One log, per the rule.

---

## 6. ERD

```mermaid
erDiagram
  dealerships ||--o{ contacts : has
  dealerships ||--o{ inventory : has
  dealerships ||--o{ deals : has
  dealerships ||--o{ profiles : employs
  contacts ||--o{ deals : "buyer"
  inventory ||--o{ deals : "vehicle"
  inventory ||--|| recon : "get-ready"
  deals ||--o{ dealer_tasks : spawns
  inventory ||--o{ dealer_tasks : "recon tasks"
  contacts ||--o{ dealer_tasks : "customer tasks"
  workflow_templates ||--o{ workflow_steps : contains
  workflow_templates ||--o{ workflow_instances : instantiated
  workflow_instances ||--o{ dealer_tasks : creates
  dealer_tasks ||--o{ task_dependencies : gated
  events }o--|| dealerships : logs
  exceptions }o--|| dealerships : flags
  state_ownership }o--|| dealerships : configures
  events ..> contacts : "entity_type=customer"
  events ..> inventory : "entity_type=vehicle"
  events ..> deals : "entity_type=deal"
```
(Dotted = polymorphic `entity_type`/`entity_id`, not a hard FK.)

---

## 7. Event catalog (each maps to a real existing endpoint where the emit is added)

| Event | Fired from (existing code) |
|---|---|
| `customer.created` | `crm.js` contact create |
| `license.scanned` | `ai.js` `/crm/scan-license` |
| `lead.created` | `leads.js` |
| `vehicle.arrived` | `sync/engine.js` feed sync / manual add |
| `trade.submitted` / `trade.approved` | `trade_appraisals` flow |
| `deal.created` | `dashboard.js` `/reports/deal` |
| `deal.status_changed` (:sold/:delivered/…) | `dashboard.js` `/reports/deal/status` |
| `deposit.paid` | `deposits.js` `stampDepositPaid` |
| `document.signed` | `esign.js` webhook |
| `recon.stage_changed` | `recon.js` `/recon/:id/stage` |
| `service.booked` | `service.js` appointments |

---

## 8. Workflow engine logic

On an event: **(1)** write `events` row → **(2)** find active `workflow_templates`
matching `trigger_event` → **(3)** create `workflow_instance` (dedupe on running) →
**(4)** materialize `workflow_steps`:
- system action → execute immediately (update_state / post_ledger / post_commission
  / add_timeline / notify / create_exception);
- human action → create `dealer_tasks` row (department + owner from
  `state_ownership`) + `task_dependencies` from `depends_on`. → **(5)** monitor:
  when a task completes, mark step done, advance `current_step`, run next steps,
  and when the terminal step's condition is met, transition the entity's own state
  (which emits the next event → next workflow). Idempotent throughout.

---

## 9. The three seed templates (JSON blueprints)

### 9.1 Sold Vehicle Delivery — trigger `deal.status_changed:sold`
```json
{
  "name": "Sold Vehicle Delivery", "target_entity": "deal", "trigger_event": "deal.status_changed:sold",
  "steps": [
    { "order": 1, "name": "PDI check",        "action_type": "create_task", "department": "Service",   "config": { "kind": "Safety", "title": "PDI check" } },
    { "order": 2, "name": "Safety",           "action_type": "create_task", "department": "Service",   "config": { "kind": "Safety", "title": "Safety inspection" } },
    { "order": 3, "name": "Detail",           "action_type": "create_task", "department": "Cleanup",   "config": { "kind": "Detail", "title": "Detail vehicle" } },
    { "order": 4, "name": "Fuel",             "action_type": "create_task", "department": "Cleanup",   "config": { "kind": "Fuel",   "title": "Fuel vehicle" } },
    { "order": 5, "name": "Photos",           "action_type": "create_task", "department": "Marketing", "config": { "kind": "Photos", "title": "Delivery photos" } },
    { "order": 6, "name": "Install plates",   "action_type": "create_task", "department": "Sales",     "config": { "kind": "Plates", "title": "Install licence plates" } },
    { "order": 7, "name": "Post revenue",     "action_type": "post_ledger",     "department": "Accounting" },
    { "order": 8, "name": "Post commission",  "action_type": "post_commission", "department": "Accounting" },
    { "order": 9, "name": "Schedule delivery","action_type": "create_task", "department": "Sales",     "config": { "kind": "Deliver", "title": "Schedule & confirm delivery" }, "depends_on": [1,2,3,6] },
    { "order": 10,"name": "Review request",   "action_type": "send_sms",        "department": "CRM", "depends_on": [9] }
  ]
}
```
*Hard dependency:* step 9 (delivery) is blocked until PDI, Safety, Detail, Plates
are complete — enforced by `task_dependencies`.

### 9.2 Trade Acquisition — trigger `trade.approved`
```json
{
  "name": "Trade Acquisition", "target_entity": "vehicle", "trigger_event": "trade.approved",
  "steps": [
    { "order": 1, "name": "Create inventory unit", "action_type": "update_state", "config": { "to_state": "won" } },
    { "order": 2, "name": "VIN decode",  "action_type": "system_vin_decode", "department": "Sales" },
    { "order": 3, "name": "Carfax",      "action_type": "system_carfax",     "department": "Sales" },
    { "order": 4, "name": "Inspection",  "action_type": "create_task", "department": "Service", "config": { "kind": "Safety", "title": "Incoming inspection" } },
    { "order": 5, "name": "Safety",      "action_type": "create_task", "department": "Service", "config": { "kind": "Safety", "title": "Safety" }, "depends_on": [4] },
    { "order": 6, "name": "Recon",       "action_type": "create_task", "department": "Service", "config": { "kind": "Parts", "title": "Recon" }, "depends_on": [5] },
    { "order": 7, "name": "Photos",      "action_type": "create_task", "department": "Marketing", "config": { "kind": "Photos", "title": "Photograph" }, "depends_on": [6] },
    { "order": 8, "name": "List live",   "action_type": "update_state", "config": { "to_state": "live" }, "depends_on": [7] }
  ]
}
```

### 9.3 New Lead — trigger `lead.created`
```json
{
  "name": "New Lead Follow-Up", "target_entity": "customer", "trigger_event": "lead.created",
  "steps": [
    { "order": 1, "name": "Notify salesperson", "action_type": "send_notification", "department": "Sales" },
    { "order": 2, "name": "5-min SLA timer",    "action_type": "wait", "config": { "minutes": 5 } },
    { "order": 3, "name": "Escalate if silent", "action_type": "create_exception", "department": "Sales Manager", "config": { "kind": "lead_unanswered", "unless_event": "customer.contacted" } },
    { "order": 4, "name": "Follow-up task",     "action_type": "create_task", "department": "Sales", "config": { "kind": "Call", "title": "Call new lead" } }
  ]
}
```

---

## 10. Unified Timeline (one log, per your rule)

The timeline is `events` rendered for an entity + its related records. A customer
timeline merges customer + its deal + its vehicle events into one stream:
```
09:01 Customer created            09:12 Manager approved appraisal
09:02 Driver's licence scanned    10:22 Deposit paid
09:05 Trade appraised             11:03 Finance approved
09:28 Test drive started          2:40  Vehicle detailed
                                  4:12  Delivered
```
No separate activity-log tables — everything emits to `events`.

---

## 11. Five-section screen standard (UI law)

Every entity page (customer, vehicle, deal, service job, vendor, appraisal) uses the
**same five sections**:
1. **Summary** — the key facts.
2. **Timeline** — the `events` stream.
3. **Current State** — the one owned state + its department/owner.
4. **Next Action** — *state · next required action · who owns it · what's blocking · [Start →]* (computed from the open workflow instance).
5. **Related Records** — linked deal, customer, vehicle, appraisal, accounting, tasks, service history.

**Manager dashboard** is the roll-up of section 4 across the store:
`deals waiting · cars blocked · overdue deliveries · leads unanswered · finance
approvals · vehicles waiting on photos · open exceptions`.

---

## 12. API routes (to be added — none built yet)

```
POST /events                     (internal emit; also GET /events?entity= for timeline)
GET  /timeline/:entityType/:id   (merged events for entity + related)
GET/POST/PUT /workflow-templates       + /:id/steps
GET  /workflow-instances?entity=       + POST /:id/advance /cancel
GET/POST/PUT /tasks (unified over dealer_tasks) + /:id/complete (enforces deps)
POST /tasks/:id/override               (manager; reason → audit_log)
GET  /exceptions  + POST /:id/ack /resolve
GET  /state-ownership + PUT (per-dealer overrides)
GET  /command-center             (manager dashboard roll-up)
GET  /next-action/:entityType/:id
```

---

## 13. Rollout, safety & validation

**Build order:** State model & back-map → Events bus → Workflow engine → System
Actions → Task engine (deps + override) → Automation fold-in → Exceptions →
Next-Action UI + Command Center.

**Dual-run:** new `emitEvent()` calls go in *alongside* today's hard-coded triggers;
we retire a hard-coded path only once its template is proven. Nothing breaks mid-flight.

**Do NOT break:** the Task Board + recon two-way sync (just shipped), deal→books/
commission posting, drip/automation, CRM, deposits, accounting.

**Validation per stage:** SQL existence checks · emit a test event → assert one
instance + correct tasks + dependency graph · dependency-block test (deliver with
Safety open → blocked; manager override → allowed + audit row) · exception scan
dry-run · UI smoke on the five-section pages.

---

## 14. Open questions before Stage 1

1. **Vehicle state**: keep `inventory.status` + `recon.stage` split with a composed
   `lifecycle_state` (recommended), or collapse into one column?
2. **Departments**: use the 9 above, or does your store use different names?
3. **Template editor**: seed the 3 as JSON now, build the visual editor later
   (recommended) — confirm.
4. **Vendors**: `assigned_vendor_id` on tasks — reuse `expense_vendors`, or a new
   `vendors` table shared by expenses + body-shop tasks?

Approve this (or edit sections 3–5 and the open questions) and I'll apply **Stage 1
(schema)** only, explaining each migration as it goes.
