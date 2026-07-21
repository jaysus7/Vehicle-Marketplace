# Deposits & payments — turning them on

Everything below is **already built and deployed** in the app. Nothing here is a
code change — it's the one-time provisioning that flips each option from
"greyed out" to "live." Same model as calendar sync: **you (the platform owner)
set the app credentials once on the server, and then each dealer connects their
own account with one click** — you never handle a dealer's banking details.

There are three separate money rails. They're independent — turn on whichever
you want.

---

## 1. Card deposits (Stripe Connect) — ACH & Interac live here too

**What the dealer sees:** Integrations → **Online deposits** card.

**Status today:** This one is *already on* as soon as `STRIPE_SECRET_KEY` is set
on the backend (it is — it's the same key that runs subscription billing). Each
dealer clicks **Connect Stripe**, finishes Stripe's onboarding, sets a deposit
amount, and flips *"Show Reserve with a deposit on my site."*

### ACH (US) and e-transfer / pre-authorized debit (Canada)

This is **not a separate integration** — it lives *inside* the Online deposits
card as the checkbox **"Also accept bank transfer."** That's why it looked
missing: the toggle only appears **after** a dealer has connected Stripe and
finished onboarding (i.e. the card is in its "ready" state). Steps for a dealer:

1. Integrations → Online deposits → **Connect Stripe** → finish onboarding.
2. Come back; the card now shows the amount field. Tick **"Also accept bank
   transfer."** → **Save.**
3. **Enable the method in their own Stripe dashboard** (Stripe → Settings →
   Payment methods): turn on **ACH Direct Debit** (US) or **Pre-authorized
   debit / acss_debit** (Canada). Stripe requires the connected account to
   opt in to the bank rail; MarketSync can't do that on their behalf.

Under the hood we send `us_bank_account` (US) or `acss_debit` (Canada) alongside
`card` at checkout. If the dealer hasn't enabled the bank method yet, Stripe
rejects it and we **automatically retry card-only**, so a deposit link never
breaks — the customer just won't see the bank option until step 3 is done.

> **"Interac e-Transfer" specifically:** Stripe doesn't expose Interac
> *e-Transfer* as a Checkout method. The Canadian bank rail Stripe gives us is
> **acss_debit (pre-authorized debit)**, which is the direct bank-to-bank
> equivalent for reserving a vehicle. True Interac e-Transfer would need Square
> (below) or a separate Interac provider — tell me if you want that and I'll
> scope it.

**No env vars needed beyond `STRIPE_SECRET_KEY`.** Card + ACH + PAD are all live now.

---

## 2. Square deposits

**What the dealer sees:** Integrations → **Square** card.

**Status today:** Greyed out / no **Connect Square** button, because the server
is missing the Square *app* credentials. The whole flow (OAuth connect, deposit
links, webhook, disconnect) is coded — it's gated on these env vars being present.

### One-time setup (you, the owner)

1. Go to the **Square Developer Dashboard** → create an application.
2. In that app's **OAuth** settings, add this **Redirect URL**:

   ```
   https://vehicle-marketplace-s0e4.onrender.com/square/callback
   ```

   (This is `${BACKEND_URL}/square/callback`. `BACKEND_URL` resolves from
   `API_URL` / `RENDER_EXTERNAL_URL` — the Render backend URL above.)
3. Register a **Webhook** subscription pointing to:

   ```
   https://vehicle-marketplace-s0e4.onrender.com/square/webhook
   ```

   Subscribe to the **`payment.updated`** event.
4. Set these environment variables on the **backend** (Render → the backend
   service → Environment):

   | Variable | Value |
   |---|---|
   | `SQUARE_APP_ID` | Application ID from the Square app |
   | `SQUARE_APP_SECRET` | Application Secret (OAuth) from the Square app |
   | `SQUARE_ENV` | `production` (or `sandbox` while testing) |
   | `SQUARE_WEBHOOK_SIGNATURE_KEY` | Signature key from the webhook subscription |

5. Redeploy the backend. The **Connect Square** button appears immediately.

Each dealer then clicks **Connect Square** → authorizes their own Square account
via OAuth. Their token is stored encrypted per-dealer; deposits route to *their*
Square, not yours. Nothing about their account touches your credentials.

---

## Why this isn't a bug (quick mental model)

| Rail | App credential (you, once) | Per-dealer connect | Extra dealer step |
|---|---|---|---|
| Card / ACH / PAD | `STRIPE_SECRET_KEY` ✅ set | Connect Stripe | Tick "bank transfer" + enable method in Stripe |
| Square | `SQUARE_APP_ID` + `SQUARE_APP_SECRET` ❌ **not set** | Connect Square | — |
| Calendar | `GOOGLE_CALENDAR_CLIENT_ID/SECRET` (+ MS_ variants) | Connect Google | — |

Same pattern every time: the app-level keys are yours and set once; the
dealer-level tokens are theirs and gathered by one OAuth click. Card + ACH + PAD
are ready right now; Square just needs the four env vars above.
