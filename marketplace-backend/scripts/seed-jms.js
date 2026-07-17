/**
 * Seed the internal MarketSync workspace — "JMS Automotive" (sales@marketsync.link).
 *
 * This is a normal dealer account that MarketSync's own team uses to track dealer
 * leads — it piggybacks on the existing app (same tables/UI) and has NO connection
 * to real dealership customers. Each seeded "customer" is a dealership prospect and
 * each "deal" is a MarketSync package sale, so the founder can work leads in the CRM
 * and desk them like any other deal.
 *
 * Idempotent: safe to run repeatedly. It finds-or-creates the auth user, the
 * dealership, the owner profile, and each contact/deal (matched by email).
 *
 * Run from marketplace-backend/ with the service-role env loaded:
 *     node scripts/seed-jms.js
 * Optional: SEED_JMS_PASSWORD=... to set the login password (default below).
 */
import { supabaseAdmin } from '../shared.js'

const EMAIL = 'sales@marketsync.link'
const PASSWORD = process.env.SEED_JMS_PASSWORD || 'MarketSync!Demo2026'
const DEALER_NAME = 'JMS Automotive'
const OWNER_NAME = 'JMS Automotive — Sales'

const log = (...a) => console.log('[seed-jms]', ...a)

// ── 1. Auth user ────────────────────────────────────────────────────────────
async function ensureUser() {
  // listUsers is paginated; search a couple of pages for our email.
  for (let page = 1; page <= 5; page++) {
    const { data } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 })
    const hit = (data?.users || []).find(u => (u.email || '').toLowerCase() === EMAIL)
    if (hit) { log('user exists:', hit.id); return hit.id }
    if (!data || (data.users || []).length < 1000) break
  }
  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email: EMAIL, password: PASSWORD, email_confirm: true,
    user_metadata: { full_name: OWNER_NAME },
  })
  if (error) throw error
  log('created user:', data.user.id, '(password:', PASSWORD + ')')
  return data.user.id
}

// ── 2. Dealership ───────────────────────────────────────────────────────────
async function ensureDealership() {
  const { data: found } = await supabaseAdmin.from('dealerships')
    .select('id').eq('name', DEALER_NAME).maybeSingle()
  if (found) { log('dealership exists:', found.id); return found.id }
  const farFuture = new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000).toISOString()
  const { data, error } = await supabaseAdmin.from('dealerships').insert({
    name: DEALER_NAME,
    website_url: 'https://marketsync.link',
    billing_status: 'ACTIVE',
    full_access_until: farFuture,   // internal account: keep everything unlocked
    ai_boost_active: true,
    inv_intel_active: true,
  }).select().single()
  if (error) throw error
  log('created dealership:', data.id)
  return data.id
}

// ── 3. Owner profile ────────────────────────────────────────────────────────
async function ensureProfile(userId, dealershipId) {
  const { data: found } = await supabaseAdmin.from('profiles').select('id').eq('id', userId).maybeSingle()
  if (found) {
    await supabaseAdmin.from('profiles').update({ dealership_id: dealershipId }).eq('id', userId)
    log('profile exists (linked to dealership)')
    return
  }
  const { error } = await supabaseAdmin.from('profiles').insert({
    id: userId, dealership_id: dealershipId, full_name: OWNER_NAME,
    role: 'DEALER_ADMIN', account_role: 'dealer_admin', price_tier: 'DEALER',
    registration_id: 'MS-001',
  })
  if (error) throw error
  log('created owner profile')
}

// ── 4. Customers (dealership prospects) + 5. Deals (MarketSync packages) ──────
// status: uncontacted | contacted | appointment | sold | fni | turnover | delivered | followup | lost
// deal_status: working | pending_credit | cash | sold | delivered
const RECORDS = [
  { first: 'Rob',    last: 'Mensah',  email: 'rob@northgateauto.example',    phone: '(416) 555-0142',
    company: 'Northgate Auto Group', source: 'MarketSync website', status: 'appointment',
    note: 'Demo booked. 140-unit rooftop, wants website + inventory intelligence.',
    pkg: 'Growth', price: 6588, deal_status: 'working', num: 1000 },
  { first: 'Lisa',   last: 'Tran',    email: 'lisa@summitmotors.example',    phone: '(604) 555-0173',
    company: 'Summit Motors', source: 'Referral', status: 'contacted',
    note: 'Independent used lot. Comparing us vs vAuto. Sent pricing.',
    pkg: 'Starter', price: 3588, deal_status: 'pending_credit', num: 1001 },
  { first: 'Darnell',last: 'Price',   email: 'darnell@coastlinecars.example',phone: '(902) 555-0119',
    company: 'Coastline Cars', source: 'Facebook Marketplace', status: 'appointment',
    note: 'Second demo scheduled. Interested in Facebook auto-poster + CRM.',
    pkg: 'Pro', price: 9588, deal_status: 'working', num: 1002 },
  { first: 'Priya',  last: 'Kapoor',  email: 'priya@meadowridgeauto.example',phone: '(780) 555-0188',
    company: 'Meadow Ridge Auto', source: 'MarketSync website', status: 'sold',
    note: 'Signed! Onboarding in progress — Growth package, 3 seats.',
    pkg: 'Growth', price: 6588, deal_status: 'sold', num: 1003 },
  { first: 'Frank',  last: 'Bianchi', email: 'frank@bianchiusedcars.example',phone: '(514) 555-0164',
    company: 'Bianchi Used Cars', source: 'Trade show', status: 'uncontacted',
    note: 'New lead from AutoShow. Small lot, price-sensitive — start with Starter.',
    pkg: 'Starter', price: 3588, deal_status: 'working', num: 1004 },
]

async function ensureContactAndDeal(dealershipId, ownerId, r) {
  // Contact (match by email within dealership)
  let { data: contact } = await supabaseAdmin.from('contacts')
    .select('id').eq('dealership_id', dealershipId).ilike('email', r.email).maybeSingle()
  if (!contact) {
    const { data, error } = await supabaseAdmin.from('contacts').insert({
      dealership_id: dealershipId,
      full_name: `${r.first} ${r.last}`,
      first_name: r.first, last_name: r.last,
      email: r.email, phone: r.phone, phone_mobile: r.phone,
      source: r.source, status: r.status,
      notes: `${r.company} · ${r.note}`,
      consent_email: false,
      customer_number: r.num,
      interest_vehicle: { package: r.pkg, company: r.company },
    }).select('id').single()
    if (error) throw error
    contact = data
    log('created contact:', r.first, r.last, `(${r.company})`)
  } else {
    log('contact exists:', r.email)
  }
  // Deal (one per contact — matched by contact_id)
  const { data: deal } = await supabaseAdmin.from('deals')
    .select('id').eq('dealership_id', dealershipId).eq('contact_id', contact.id).maybeSingle()
  if (!deal) {
    const { error } = await supabaseAdmin.from('deals').insert({
      dealership_id: dealershipId, contact_id: contact.id, created_by: ownerId,
      deal_number: r.num, deal_status: r.deal_status, deal_type: 'subscription',
      selling_price: r.price, total_price: r.price, payment: Math.round(r.price / 12),
      term: 12, payment_freq: 'monthly',
      notes: `MarketSync ${r.pkg} package — ${r.company}`,
      vehicle: { package: r.pkg, company: r.company, annual: r.price },
    })
    if (error) throw error
    log('created deal #', r.num, `(${r.pkg}, ${r.deal_status})`)
  } else {
    log('deal exists for', r.email)
  }
}

// ── 6. Inventory (6 mock vehicles) ───────────────────────────────────────────
const VEHICLES = [
  { stock: 'JMS-101', year: 2022, make: 'Toyota', model: 'RAV4', trim: 'XLE AWD', price: 32480, mileage: 41250, color: 'Magnetic Grey', fuel: 'Gasoline', drive: 'AWD', body: 'SUV', vin: '2T3W1RFV6NW100101' },
  { stock: 'JMS-102', year: 2021, make: 'Ford', model: 'F-150', trim: 'XLT SuperCrew', price: 41900, mileage: 58900, color: 'Velocity Blue', fuel: 'Gasoline', drive: '4WD', body: 'Truck', vin: '1FTEW1EP7MFA10102' },
  { stock: 'JMS-103', year: 2023, make: 'Honda', model: 'Civic', trim: 'Sport', price: 27650, mileage: 22750, color: 'Platinum White', fuel: 'Gasoline', drive: 'FWD', body: 'Sedan', vin: '2HGFE2F58PH100103' },
  { stock: 'JMS-104', year: 2020, make: 'Tesla', model: 'Model 3', trim: 'Long Range', price: 33200, mileage: 61200, color: 'Solid Black', fuel: 'Electric', drive: 'AWD', body: 'Sedan', vin: '5YJ3E1EB7LF100104' },
  { stock: 'JMS-105', year: 2021, make: 'Mazda', model: 'CX-5', trim: 'GT', price: 29995, mileage: 47800, color: 'Soul Red', fuel: 'Gasoline', drive: 'AWD', body: 'SUV', vin: 'JM3KFBDM1M0100105' },
  { stock: 'JMS-106', year: 2019, make: 'GMC', model: 'Sierra 1500', trim: 'SLT', price: 38700, mileage: 78400, color: 'Quicksilver', fuel: 'Gasoline', drive: '4WD', body: 'Truck', vin: '3GTU9DED8KG100106' },
]

async function ensureInventory(dealershipId) {
  const byStock = {}
  for (const v of VEHICLES) {
    let { data: found } = await supabaseAdmin.from('inventory')
      .select('id').eq('dealership_id', dealershipId).eq('stocknumber', v.stock).maybeSingle()
    if (found) { byStock[v.stock] = found.id; log('vehicle exists:', v.stock); continue }
    const { data, error } = await supabaseAdmin.from('inventory').insert({
      dealership_id: dealershipId, source: 'manual', status: 'available',
      year: v.year, make: v.make, model: v.model, trim: v.trim,
      price: v.price, mileage: v.mileage, condition: 'used',
      stocknumber: v.stock, exterior_color: v.color, fuel_type: v.fuel,
      drivetrain: v.drive, body_style: v.body, vin: v.vin,
      lot_date: new Date().toISOString(), image_urls: [],
    }).select('id').single()
    if (error) throw error
    byStock[v.stock] = data.id
    log('created vehicle:', v.stock, `${v.year} ${v.make} ${v.model}`)
  }
  return byStock
}

// ── 7. One vehicle in cleanup (recon "detail" stage) ─────────────────────────
async function ensureCleanup(dealershipId, inventoryId) {
  if (!inventoryId) return
  const { data: found } = await supabaseAdmin.from('recon')
    .select('id').eq('dealership_id', dealershipId).eq('inventory_id', inventoryId).maybeSingle()
  if (found) { log('recon record exists for cleanup car'); return }
  const now = new Date().toISOString()
  const { error } = await supabaseAdmin.from('recon').insert({
    dealership_id: dealershipId, inventory_id: inventoryId, stage: 'detail',
    notes: 'Interior detail + polish before delivery.',
    started_at: now, stage_since: now, updated_at: now, done_at: null,
  })
  if (error) throw error
  log('put JMS-101 into cleanup (recon: detail)')
}

// ── 8. Two car buyers + deals (one on the car in cleanup) ────────────────────
const BUYERS = [
  { first: 'Marcus', last: 'Bell', email: 'marcus.bell@example.com', phone: '(416) 555-0210',
    status: 'sold', num: 1005, stock: 'JMS-101', price: 32480, deal_status: 'sold',
    note: 'Bought the RAV4 — in cleanup/detail before delivery.' },
  { first: 'Elena',  last: 'Fisher', email: 'elena.fisher@example.com', phone: '(647) 555-0233',
    status: 'appointment', num: 1006, stock: 'JMS-103', price: 27650, deal_status: 'working',
    note: 'Test drove the Civic Sport — working the numbers.' },
]

async function ensureBuyerDeals(dealershipId, ownerId, byStock) {
  for (const r of BUYERS) {
    let { data: contact } = await supabaseAdmin.from('contacts')
      .select('id').eq('dealership_id', dealershipId).ilike('email', r.email).maybeSingle()
    if (!contact) {
      const { data, error } = await supabaseAdmin.from('contacts').insert({
        dealership_id: dealershipId, full_name: `${r.first} ${r.last}`,
        first_name: r.first, last_name: r.last, email: r.email,
        phone: r.phone, phone_mobile: r.phone, source: 'Walk-in',
        status: r.status, notes: r.note, consent_email: false, customer_number: r.num,
      }).select('id').single()
      if (error) throw error
      contact = data
      log('created buyer:', r.first, r.last)
    } else { log('buyer exists:', r.email) }
    const { data: deal } = await supabaseAdmin.from('deals')
      .select('id').eq('dealership_id', dealershipId).eq('contact_id', contact.id).maybeSingle()
    if (!deal) {
      const invId = byStock[r.stock] || null
      const { error } = await supabaseAdmin.from('deals').insert({
        dealership_id: dealershipId, contact_id: contact.id, created_by: ownerId,
        deal_number: r.num, deal_status: r.deal_status, deal_type: 'retail',
        inventory_id: invId, selling_price: r.price, total_price: r.price,
        term: 72, payment: Math.round((r.price * 1.13) / 72), payment_freq: 'monthly',
        notes: r.note,
      })
      if (error) throw error
      log('created car deal #', r.num, `(${r.stock}, ${r.deal_status})`)
    } else { log('car deal exists for', r.email) }
  }
}

// ── 9. Ten CRM tasks ─────────────────────────────────────────────────────────
const TASKS = [
  { email: 'rob@northgateauto.example',    title: 'Call Rob to prep the demo agenda',        days: 1, done: false },
  { email: 'lisa@summitmotors.example',    title: 'Send Summit Motors the pricing PDF',       days: 0, done: true  },
  { email: 'darnell@coastlinecars.example',title: 'Confirm Coastline 2nd demo time',          days: 2, done: false },
  { email: 'priya@meadowridgeauto.example',title: 'Kick off Meadow Ridge onboarding',         days: 1, done: false },
  { email: 'frank@bianchiusedcars.example',title: 'Follow up on Bianchi intro email',         days: 3, done: false },
  { email: 'marcus.bell@example.com',      title: 'QC the RAV4 detail before delivery',       days: 1, done: false },
  { email: 'elena.fisher@example.com',     title: 'Follow up on Civic test drive',            days: 2, done: false },
  { email: 'rob@northgateauto.example',    title: 'Email Q3 roadmap to Northgate',            days: 5, done: false },
  { email: 'lisa@summitmotors.example',    title: 'Check credit-app status — Summit',         days: 1, done: false },
  { email: 'priya@meadowridgeauto.example',title: 'Schedule delivery for Meadow Ridge',       days: 4, done: false },
]

async function ensureTasks(dealershipId, ownerId) {
  // Map emails -> contact ids.
  const { data: contacts } = await supabaseAdmin.from('contacts')
    .select('id, email').eq('dealership_id', dealershipId)
  const idByEmail = {}
  for (const c of (contacts || [])) if (c.email) idByEmail[c.email.toLowerCase()] = c.id
  let made = 0
  for (const t of TASKS) {
    const contactId = idByEmail[t.email.toLowerCase()]
    if (!contactId) { log('task skip (no contact):', t.email); continue }
    const { data: exists } = await supabaseAdmin.from('crm_tasks')
      .select('id').eq('contact_id', contactId).eq('title', t.title).maybeSingle()
    if (exists) continue
    const due = new Date(); due.setDate(due.getDate() + t.days); due.setHours(9, 0, 0, 0)
    const { error } = await supabaseAdmin.from('crm_tasks').insert({
      dealership_id: dealershipId, contact_id: contactId,
      assigned_to: ownerId, created_by: ownerId,
      title: t.title, type: 'followup', due_at: due.toISOString(), done: t.done,
    })
    if (error) throw error
    made++
  }
  log('created', made, 'new task(s) (of', TASKS.length + ' defined)')
}

async function main() {
  log('seeding internal MarketSync workspace …')
  const userId = await ensureUser()
  const dealershipId = await ensureDealership()
  await ensureProfile(userId, dealershipId)
  for (const r of RECORDS) await ensureContactAndDeal(dealershipId, userId, r)
  const byStock = await ensureInventory(dealershipId)
  await ensureCleanup(dealershipId, byStock['JMS-101'])
  await ensureBuyerDeals(dealershipId, userId, byStock)
  await ensureTasks(dealershipId, userId)
  log('done. Login:', EMAIL, '/ password:', PASSWORD)
  log('Dealership:', DEALER_NAME, '(' + dealershipId + ') — 7 customers, 7 deals, 6 vehicles (1 in cleanup), 10 tasks.')
}

main().then(() => process.exit(0)).catch(e => { console.error('[seed-jms] FAILED:', e.message); process.exit(1) })
