# MarketSync — Backlog / "suggested but not done"

Running list of things discussed or recommended that are **not yet built**, so nothing
falls through the cracks. Grouped by theme, roughly in priority order.

_Last updated: 2026-07-18_

## ✅ Shipped 2026-07-18 (this round)

- **AI sales-chat tuning (public site concierge).** Settings → Website → AI sales chat
  now has a dealer **knowledge base** (paste or upload .txt/.md, ~12k chars),
  **special instructions** (~4k — tone/emphasis/handoff, layered above the core
  honesty rules), and a **disclaimer** (~600, worked in on pricing/terms/availability).
  Stored in branding (`site_chat_kb/_instructions/_disclaimer`), injected into the
  `/site/:slug/chat` system prompt only when non-empty.
- **Geo-aware holiday greetings.** Full 2026 CA + US preset list; each greeting is
  tagged CA / US / Everyone and only sends to customers in that country (derived from
  contact country → province/state → postal/ZIP, falling back to the dealership's own
  region). Floating dates (Thanksgiving, Labour/Labor, Victoria Day, Family Day,
  Memorial Day, Good Friday/Easter Monday) resolve by rule per year so they never
  drift. Custom holidays pick their own audience.
- **Two-column settings.** The Settings hub and Automation settings flow into two
  columns on wide screens; a tab with a single card stays full-width (JS toggles
  `.is-multi` only when >1 card shows). Website settings was already two-column.

## ✅ Shipped 2026-07-19

- **AI chat transcripts on the customer card** — the website concierge's full
  conversation is saved (communications, meta.kind='ai_chat') and viewable via a
  "View AI conversation" chat-bubble modal. Generic POST /crm/contacts/:id/chat-log
  lets the marketplace/extension path attach threads too.
- **Native demo booking (Calendly removed)** — the marketing site's "Book a 30-min
  demo" is now a native modal (date + time picker). POST /marketsync/book creates a
  no-account Jitsi video room, books it onto the MarketSync team's CRM calendar as an
  appointment, drops the join link on the customer timeline, and emails the customer +
  the team with the link + add-to-Google-Calendar. faq.html + index.html Calendly links
  removed. (For a real Google Meet link instead of Jitsi, we'd add the Google Calendar
  API via the existing Google OAuth connector.)
- **MarketSync-leads filter fix** — demo/marketing leads (source 'MarketSync …',
  'Demo …') now show under the filter (prefix-matched).
- **Native test-drive booking on dealer sites** — "Book a test drive" on each vehicle
  → routed to a rep, on the dealer's CRM calendar, video link + emails.
- **Owner Demo ↔ MarketSync dashboard** — a page-level workspace switch (owner only).
  MarketSync mode = purple theme + trimmed nav/Settings on the real MarketSync (JMS)
  workspace. Demo mode = a SEPARATE seeded demo dealership (routes/demo.js: fake
  cars + customers across every stage) reached via an owner-only X-Act-Demo header
  (middleware) + a global fetch wrapper, with a per-contact "walk the deal
  forward/back" stepper and a Reset-demo control. Anything built on the dealer side
  shows in Demo automatically. Remaining: deeper MarketSync-specific page content
  (e.g., Sales→MRR analytics) — today the MarketSync workspace's deals are already
  subscription-type so the Sales/F&I page reads correctly.

## ✅ Phase 2 (Integrations — "the glue") — shipped earlier

- **Integrations Hub** (Settings → Integrations, admin-only) — lists every connectable
  service grouped by category, live vs. coming-soon.
- **Outbound Webhooks / Zapier** (live now): dealer pastes an endpoint URL + optional
  HMAC signing secret and picks which events to send. "Send test" fires a `test.ping`.
  Events emitted: `lead.created` (lead-routing), `deal.sold` / `deal.delivered`
  (`/reports/deal/status`), `appointment.booked` (CRM status → appointment). Signed as
  `X-MarketSync-Signature: sha256=…` when a secret is set. Fire-and-forget, never blocks a request.
- **QuickBooks Online — connector built (Intuit OAuth2).** Real authorization-code
  flow: Settings → Integrations → Connect QuickBooks → Intuit consent → tokens stored
  encrypted per dealer, auto-refreshed; "Test connection" names the linked company.
  Inert until MarketSync provisions its Intuit app — one ops step (see below).
- **Xero + Google Business — connectors built** on a shared generic OAuth2 engine
  (`providers/oauth.js`): Connect → provider consent → encrypted per-dealer tokens,
  auto-refreshed; "Test connection" names the linked org/account. Xero also captures
  the tenant via /connections. Inert until their app credentials are provisioned.
- **Integrations Hub polished:** connected/available summary, category sections with
  blurbs, per-provider icons, live-first ordering, unified Connected/Available/Coming-
  soon states across webhook, Twilio, and all OAuth connectors.
- **Accounting income sync — built** (`providers/accounting.js`). On deal **delivered**
  (desk status + F&I "Delivered"), the deal is booked into the connected accounting
  system: **QuickBooks** SalesReceipt (auto-ensures a "Vehicle Sale (MarketSync)" item
  against the first income account + the customer) or **Xero** ACCREC invoice (account
  code 200). Safe by design: **opt-in per dealer** ("Auto-post income on delivery"
  toggle, off by default), **idempotent** (`deals.accounting_synced_at`), fire-and-forget.
  ⚠️ Not yet exercised against a live QBO/Xero sandbox — verify item/account mapping
  before a dealer turns autosync on in production.
- **Twilio SMS — LIVE (bring-your-own account).** A dealer stores their own Twilio
  SID + token (encrypted) and from-number; when connected, every automated text sends
  from their own A2P-registered number instead of the shared MarketSync number.
  "Send test text" sends a real SMS. Falls back to the shared env-var Twilio when not
  connected. Creds cached 60s per dealership, invalidated on save/disconnect.

---

## 0. Setup / deploy reminders (required for already-shipped features to work)

These are done in code + DB but need one-time ops before they run in production:

- [ ] **Set `PII_ENCRYPTION_KEY`** on Render — `openssl rand -hex 32`. Required to save
      SIN/DOB on credit apps and to store vendor credentials. Fails closed without it.
- [ ] **Redeploy the backend** so the new routes load: `/credit`, `/integrations`,
      `/history`, `/marketsync`, digital-retailing lead handling.
- [ ] **Confirm `CARAPI_API`** is set (VIN-decode fallback) and **`ANTHROPIC_API_KEY`**
      (MarketSync sales chatbot + dealer concierge).
- [ ] **`npm run seed:jms`** on Render to (re)load the JMS Automotive demo data
      (5 subscription leads + 6 cars, 1 in cleanup + 2 car deals + 10 tasks).
- [ ] Migrations already applied to Supabase via MCP: credit-app/security, desk tax +
      lease + reserve, `tax_country`, `vehicle_history_reports`. (Files under
      `marketplace-backend/migrations/` for the record.)
- [ ] Extension **v1.16.10** Chrome Web Store repackage (recurring, user-side).
- [ ] `SITEMAP_LITE_SYNC=1` on Render (feed validation).
- [ ] **OAuth connectors — one ops step each** (they show "coming soon" until set,
      then flip to a live "Connect" button). Register one app per provider and set:
      - **QuickBooks:** `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_ENV=production`.
        Redirect URI: `{API_URL}/integrations/quickbooks/callback`.
      - **Xero:** `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`.
        Redirect URI: `{API_URL}/integrations/xero/callback`.
      - **Google Business:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
        Redirect URI: `{API_URL}/integrations/google_business/callback`.
      - Optional `OAUTH_STATE_SECRET` (defaults to the service-role key) signs the
        OAuth state.

---

## 1. Integrations — go-live (gated behind DSP / partner approval)

The provider abstractions + encrypted credential storage are built; these flip on once
certified. All run in **manual/export mode** today.

- [x] **Integrations Settings UI** — Carfax / RouteOne / Dealertrack now render a
      credentials form in the Integrations Hub ("Manual mode" pill). The dealer stages
      credentials now (secret fields encrypted into `credentials_enc`, non-secret into
      `lender_code_map`); they flip to a native pull once certified with no re-entry.
      Done 2026-07-18 (`fniCredsCard` / `saveFniCreds`; catalog `manual` + `fields`).
- [ ] **Carfax** live native pull (VHR / lien / valuation) — replace the manual
      deep-link + attach with a real `CarfaxCanadaProvider` (`providers/history.js`).
- [ ] **RouteOne** live credit submit + decision polling — real provider behind
      `providers/credit.js` (currently STAR-XML export you upload manually).
- [ ] **Dealertrack DealTransfer** live submit (last, most stringent audit).
- [ ] Partner prerequisites for the above: SOC 2 roadmap, cyber-liability insurance,
      DSP applications, lender-code mapping per vendor.

---

## 2. Digital retailing / F&I follow-ups

- [x] **Online deposit capture (Stripe Connect)** — dealers connect their OWN Stripe
      account (Integrations → Payments), set a refundable deposit amount, and flip it on;
      the public site's "Reserve" then takes a real deposit via Stripe Checkout
      (destination charge → funds to the dealer, platform liable). Webhook stamps the
      contact/lead "paid", tags Deposit, and alerts the rep. Storage in dealer_integrations
      (no migration). Done 2026-07-18 (routes/deposits.js). ⚠️ OPS: set STRIPE_SECRET_KEY
      (already set) + ensure the Connect capability is enabled on the platform Stripe
      account; the same STRIPE_WEBHOOK_SECRET endpoint handles deposit events.
- [ ] **Filter subscription-type deals out of the F&I worklist** — the JMS demo
      subscription leads show "Vehicle" with no car; optional cleanup.
- [x] **"MarketSync Leads" view** — a "✨ MarketSync leads" toggle chip on the Customers
      page filters to leads that came through our own website + AI chat + DR shells
      (Website, Website Chat, Trade-In, Credit Application, Build & Price, Reserve/Deposit,
      Payment Quote). Backend `/crm/contacts?source=marketsync`. Done 2026-07-18.
- [x] Credit-app **print/PDF** — "Print / PDF" button on the credit-application modal
      renders a clean printable application (applicant/co-applicant/vehicle/financing +
      signature lines) from the live form and opens the browser print dialog
      (`creditAppPrintDoc`). SIN/DOB print only if revealed. Done 2026-07-18.
- [ ] Credit-app: co-applicant references, previous address/employment (<2 yr).

---

## 3. Tax engine precision (US especially)

- [ ] **US local/county rates** — today it fills the **state base rate** (editable) with
      the trade-in credit rule per state. County/city stacking + special vehicle rates
      (GA TAVT, NC 3% highway-use, etc.) need a ZIP→jurisdiction source
      (Avalara / TaxJar or a maintained table).
- [ ] **CA split edge cases** — luxury-vehicle PST brackets (e.g. BC tiered PST) and any
      province where GST vs PST bases differ from the "trade reduces both" default.
- [x] **License-plate → VIN** lookup for trade appraisal. "Look up by plate" on the
      appraisal (plate + state/province) resolves the VIN and runs the normal decode.
      providers/plateLookup.js supports CarsXE (`CARSXE_API_KEY`) or Vehicle Databases
      (`VEHICLE_DATABASES_API_KEY`); route POST /ai/plate-decode. The UI only appears
      when a provider key is set (`plate_lookup_ready` in /ai/config) so it's never a
      dead button. ⚠️ OPS: set one of those API keys to turn it on. Done 2026-07-19.

---

## 4. The "AI dealership brain" (biggest differentiator per the advisor)

**Shipped (v1):** "Ask MarketSync" is now cross-data. Beyond the live inventory/lead
snapshot it can call a `dealership_report` tool that joins **sales, gross, F&I,
commissions, per-rep leaderboard, lead volume/sources/conversion, unworked leads,
reconditioning status, overdue tasks, today's appointments (who to call today), and
recent trade appraisals** — all from the store's own data, manager-gated on the
financial slices. The base snapshot also carries a month-to-date sales pulse.

**Deepened 2026-07-18:** added `trends` (period-over-period sales/lead/gross deltas)
and `priorities` ("what needs attention right now") topics to `dealership_report`,
and the concierge system prompt now frames MarketSync as "the smartest person at the
dealership."

Still to deepen:
- [x] Which cars should I discount / wholesale / send to auction today? — `pricing`
      topic: per-unit actions from days-on-lot, off-market price flags and missing
      prices (discount / wholesale / auction / add-price / refresh). Done 2026-07-18.
      (A live market-comp per-unit layer would sharpen the reprice target further.)
- [x] Why did leads drop this month? (period-over-period trend) — `trends` topic.
- [x] Equity-based "who to call" — `equity` topic reuses the Equity Radar engine to
      rank delivered customers in positive-equity / lease-maturing positions with
      phone + rep + tier. Done 2026-07-18.
- [x] Which marketing campaign made money? — Marketing ROI attribution shipped.
      Reports → Marketing ROI joins keyed-in monthly spend (marketing_spend table)
      with leads/attributed sales/revenue by channel → cost-per-lead, cost-per-sale,
      est. gross, ROI. `marketing_roi` dealership_report topic. Done 2026-07-19.
- [x] Live market-comp per-unit reprice targets — the `pricing` topic pulls a live
      MarketCheck median for the top reprice candidates and names a target + how far
      above/below market each unit sits. Done 2026-07-19.
- [x] AI persona/style settings (internal + customer) + knowledge-base upload —
      Settings → AI; feeds both the internal assistant and the website chat.
      Done 2026-07-19.
- [x] Natural-language bulk outreach — `/ai/bulk/plan` + `/ai/bulk/execute`: plain-
      English → structured filter + drafted message → reviewed preview → confirmed
      send (consent-enforced, capped, logged). "Bulk message" on the CRM page.
      Done 2026-07-19.
- [x] Proactive WEEKLY briefing — AI-written recap (WoW units/revenue/leads/
      appraisals + what to fix), configurable day/email/focus in Automation settings.
      Done 2026-07-19. ⚠️ OPS: schedule a daily POST to `/cron/weekly-briefing`.
- [x] Proactive morning briefing — `runMorningDigest()` pushes a "what needs attention
      today" summary (uncontacted leads, overdue tasks, aging units, appointments, sold-
      awaiting-delivery + a sales/lead pulse) to managers in-app, and by email when the
      dealer opts in. Toggles live in Automation → Global settings, with an "email me a
      preview" button. Done 2026-07-18. ⚠️ OPS: schedule a daily POST to
      `/cron/morning-digest` (x-cron-secret header), e.g. 7am, next to the existing
      automation-daily cron.

---

## 5. Fixed operations (later — after front office is locked in)

- [x] Service **appointment scheduling** — light fixed-ops Service area shipped
      (routes/service.js). New "Service" nav group: Appointments, Equity Mining,
      Settings. Service appointments are crm_tasks (type=appointment,
      category=service) attached to the SAME contact as sales history; booking one
      flips contacts.service_customer=true. Online booking endpoint
      POST /site/:slug/service-book (dealer opt-in). Customer card shows Sales /
      Service tags. Done 2026-07-19.
- [ ] **Repair orders** + technicians + inspections (deferred — DMS-scale build)
- [ ] Customer **maintenance-history portal**
- [ ] **Parts inventory**
- [ ] Service booking **widget on the dealer website** (site.html) — endpoint is
      live; still to add the front-end booking form (mirror the test-drive flow).

## 6. Deliberately NOT building (per advisor + agreed)

- **Native accounting / dealership GL.** Sync to **QuickBooks / Xero / Sage** instead.
  Building a GL is an enormous, low-ROI undertaking until real scale.

---

## 7. Other "the glue" integrations to consider (front-office)

- [x] Accounting sync: **QuickBooks / Xero** (deal + F&I income out) — shipped (Phase 2).
- [x] **AutoTrader / Trader.ca / Kijiji** syndication — outbound feed shipped: public
      per-dealer CSV + XML inventory feeds (`/syndication/:slug/inventory.csv|.xml`)
      the dealer hands to each platform's portal; auto-current, 30-min cache. Dashboard
      "Listing Syndication" card surfaces + copies the feed URLs. Done 2026-07-18
      (routes/syndication.js). Google-vehicle-listings feed shape added
      (/syndication/:slug/google.xml). Per-platform **step-by-step setup modals**
      (AutoTrader, CarGurus, Kijiji Autos, Google Merchant, Facebook) added to the
      Syndication card — each hands the dealer the right feed URL + copy button +
      the exact portal steps. Done 2026-07-19.
- [x] **Google Business Profile** posting — AI post composer shipped (staged). The
      Google Business card now carries a "Compose a post" modal: pick a type (new
      arrival / special / general update) and optional vehicle, "Write with AI"
      drafts the post (`/integrations/google_business/compose`, AI-Boost gated), then
      Publish attempts the Business Profile localPosts API with the dealer's connected
      token (`/integrations/google_business/post` → `gbpCreatePost`). Until Google
      approves API access it returns `{staged:true}` and the UI falls back to
      copy-text + open Google Business — flips to true one-click publish with no code
      change once approved (same pattern as the F&I connectors). Done 2026-07-19.
      Review requests already trigger through the delivery drip (review cards + links
      on the site).
- [ ] SMS/voice via **Twilio** (confirm current coverage vs. what's live)
