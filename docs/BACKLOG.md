# MarketSync — Backlog / "suggested but not done"

Running list of things discussed or recommended that are **not yet built**, so nothing
falls through the cracks. Grouped by theme, roughly in priority order.

_Last updated: 2026-07-17_

## ✅ Phase 2 (Integrations — "the glue") — shipped this round

- **Integrations Hub** (Settings → Integrations, admin-only) — lists every connectable
  service grouped by category, live vs. coming-soon.
- **Outbound Webhooks / Zapier** (live now): dealer pastes an endpoint URL + optional
  HMAC signing secret and picks which events to send. "Send test" fires a `test.ping`.
  Events emitted: `lead.created` (lead-routing), `deal.sold` / `deal.delivered`
  (`/reports/deal/status`), `appointment.booked` (CRM status → appointment). Signed as
  `X-MarketSync-Signature: sha256=…` when a secret is set. Fire-and-forget, never blocks a request.
- Catalog now surfaces QuickBooks, Xero, Google Business, Twilio as **coming-soon**
  cards (credential store + provider abstraction ready; flip on when certified).

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

---

## 1. Integrations — go-live (gated behind DSP / partner approval)

The provider abstractions + encrypted credential storage are built; these flip on once
certified. All run in **manual/export mode** today.

- [ ] **Integrations Settings UI** — a Settings card to enter/stage the Carfax /
      RouteOne / Dealertrack credentials (the `/integrations` API + encrypted store
      exist; there's no form yet). Do this when you start certifying with one.
- [ ] **Carfax** live native pull (VHR / lien / valuation) — replace the manual
      deep-link + attach with a real `CarfaxCanadaProvider` (`providers/history.js`).
- [ ] **RouteOne** live credit submit + decision polling — real provider behind
      `providers/credit.js` (currently STAR-XML export you upload manually).
- [ ] **Dealertrack DealTransfer** live submit (last, most stringent audit).
- [ ] Partner prerequisites for the above: SOC 2 roadmap, cyber-liability insurance,
      DSP applications, lender-code mapping per vendor.

---

## 2. Digital retailing / F&I follow-ups

- [ ] **Online deposit capture** — "Reserve" currently just notifies the rep (by design
      for now). To actually charge the reserve deposit needs **Stripe Connect on the
      dealer's account** (consumer payment, not the subscription Stripe we have).
- [ ] **Filter subscription-type deals out of the F&I worklist** — the JMS demo
      subscription leads show "Vehicle" with no car; optional cleanup.
- [ ] **"MarketSync Leads" view** in the dashboard — a filter so chatbot-sourced /
      website DR leads are visible at a glance (they land in CRM now, just not filtered).
- [ ] Credit-app: co-applicant references, previous address/employment (<2 yr), and a
      print/PDF of the application (XML export exists; PDF is client-side TODO).

---

## 3. Tax engine precision (US especially)

- [ ] **US local/county rates** — today it fills the **state base rate** (editable) with
      the trade-in credit rule per state. County/city stacking + special vehicle rates
      (GA TAVT, NC 3% highway-use, etc.) need a ZIP→jurisdiction source
      (Avalara / TaxJar or a maintained table).
- [ ] **CA split edge cases** — luxury-vehicle PST brackets (e.g. BC tiered PST) and any
      province where GST vs PST bases differ from the "trade reduces both" default.
- [ ] **License-plate → VIN** lookup for trade appraisal (VIN-only today).

---

## 4. The "AI dealership brain" (biggest differentiator per the advisor)

"Ask MarketSync" exists (answers from inventory/leads). The deeper cross-data assistant is
not built — one place that answers, from ALL the dealership data:

- [ ] Which cars should I discount today? / cars to wholesale / send to auction / feature
- [ ] Which salesperson needs coaching?
- [ ] Why did leads drop this month?
- [ ] Which marketing campaign made money? (marketing ROI attribution)
- [ ] Which customers should we call today? (equity + service + follow-up prioritized)
- [ ] Which trades should we buy this week?

Needs a data/insight layer that joins CRM + inventory + marketing + reviews + (later)
service, feeding a reasoning prompt.

---

## 5. Fixed operations (later — after front office is locked in)

- [ ] Service **appointment scheduling**
- [ ] **Repair orders** + technicians + inspections
- [ ] Customer **maintenance-history portal**
- [ ] **Parts inventory**

## 6. Deliberately NOT building (per advisor + agreed)

- **Native accounting / dealership GL.** Sync to **QuickBooks / Xero / Sage** instead.
  Building a GL is an enormous, low-ROI undertaking until real scale.

---

## 7. Other "the glue" integrations to consider (front-office)

- [ ] Accounting sync: **QuickBooks / Xero / Sage** (deal + F&I income out)
- [ ] **AutoTrader / Trader.ca / Kijiji** syndication (beyond Facebook Marketplace)
- [ ] **Google Business Profile** posting + review request automation (reviews cards exist)
- [ ] SMS/voice via **Twilio** (confirm current coverage vs. what's live)
