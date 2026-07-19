// ─────────────────────────────────────────────────────────────────────────────
// MarketSync CRM — Automated follow-up / lifecycle / review / referral engine.
//
// Pieces:
//   • Default campaign seeding (per dealership)         → DEFAULT_CAMPAIGNS + ensureCampaigns
//   • Trigger → queue enqueue (date/event/multi-year)   → enqueueForTrigger / markDelivered
//   • Background worker (dispatch + 1h-prior precheck)   → runDue / runPrecheck
//   • Compliance "kill switches"                         → verify()
//   • Sender identity (house / rep / dynamic switch)     → resolveSender()
//   • Templating with safe fallbacks + TCPA opt-out      → renderTemplate / dispatch
//   • Drop-out freeze on inbound reply                   → freezeSequences / inbound webhook
//   • AI copy generation hook                            → /automation/ai-copy
// ─────────────────────────────────────────────────────────────────────────────
import Anthropic from '@anthropic-ai/sdk'
import { supabaseAdmin, resend, EMAIL_FROM, FRONTEND_URL } from '../shared.js'
import { requireAuth } from '../middleware.js'
import { decryptJson } from '../crypto-pii.js'
import { createNotification } from '../notifications.js'
import { aiAllowed, recordUsage } from '../usage.js'

const OWNER_EMAIL = (process.env.OWNER_EMAIL || 'massiejay@gmail.com').toLowerCase()

const DEALER_LEVEL = ['DEALER_ADMIN', 'OWNER', 'MANAGER']
const isDealerLevel = (req) => DEALER_LEVEL.includes(req.profile?.role)
const digits = (s) => String(s || '').replace(/\D/g, '')
const nowIso = () => new Date().toISOString()

// Pipeline stages that mean "a live deal is being negotiated" → pause long-term retention.
const OPEN_DEAL_STATUSES = new Set(['appointment', 'sold', 'fni', 'turnover'])

// ── Default campaigns ────────────────────────────────────────────────────────
// delay_minutes = offset from the trigger. interval_months = multi-touch markers.
// send_at_hour = align to a local hour (e.g. 9 = "morning after"). Copy uses
// {{token|fallback}} — unresolved tokens collapse to the fallback (never raw tags).
const DEFAULT_CAMPAIGNS = [
  // A. Inbound / sales pipelines
  { key: 'speed_to_lead', name: '90-Second Speed-to-Lead', category: 'pipeline', trigger_event: 'internet_lead', channel: 'sms', delay_minutes: 2, sender_identity: 'rep', sort: 10,
    message_body_template: `Hi {{customer.first_name|there}}, it's {{rep.first_name|the team}} at {{dealership.name}}. Saw you were looking at the {{vehicle.ymm|vehicle}} — is that still the one you had your eye on, or are you open to options? Happy to check availability for you.` },
  { key: 'day3_bump', name: 'Day 3 "Still Looking" Bump', category: 'pipeline', trigger_event: 'internet_lead', channel: 'sms', delay_minutes: 4320, sender_identity: 'rep', sort: 20,
    message_body_template: `Hey {{customer.first_name|there}} — did you end up finding something, or are you still shopping around for the {{vehicle.model|right vehicle}}?` },
  { key: 'post_test_drive', name: 'Post-Test Drive "No Deal"', category: 'pipeline', trigger_event: 'show_no_sale', channel: 'email', delay_minutes: 480, send_at_hour: 9, sender_identity: 'rep', sort: 30,
    subject_template: `Thanks for coming in, {{customer.first_name|there}}`,
    message_body_template: `Hi {{customer.first_name|there}},\n\nReally appreciated you taking the time to come see the {{vehicle.ymm|vehicle}} yesterday. I've been working with my management team to sharpen the numbers on the price and your trade — I think we can get closer than where we left off.\n\nMind if I give you a quick call to go over it? No pressure either way.\n\n{{rep.first_name|Your sales team}}\n{{dealership.name}}` },

  // B. Post-delivery retention lifecycle (5-year horizon)
  { key: 'delivery_day1', name: 'Delivery Day 1 — Welcome Home', category: 'retention', trigger_event: 'delivered', channel: 'sms', delay_minutes: 1440, send_at_hour: 10, sender_identity: 'rep', sort: 40,
    message_body_template: `Congrats again on the {{vehicle.ymm|new vehicle}}, {{customer.first_name|there}}! Hope the first drive was a good one. If you want a hand pairing your phone or setting up anything on the dash, just shout — happy to walk you through it. — {{rep.first_name|Your team}}` },
  { key: 'delivery_day30', name: 'Delivery Day 30 — 1 Month Milestone', category: 'retention', trigger_event: 'delivered', channel: 'email', delay_minutes: 43200, send_at_hour: 10, sender_identity: 'house', sort: 50,
    subject_template: `One month in — how's the {{vehicle.model|new ride}}?`,
    message_body_template: `Hi {{customer.first_name|there}},\n\nHard to believe it's already been a month with your {{vehicle.ymm|vehicle}}! When you're ready for that first routine maintenance, our service team makes it easy — you can book online anytime here: {{service_url|our website}}.\n\nThanks again for being part of the {{dealership.name}} family.` },
  { key: 'lifecycle_odd', name: 'Quarterly Pulse — Relational (odd months)', category: 'retention', trigger_event: 'delivered', channel: 'sms', sender_identity: 'rep', interval_months: [3, 9, 15, 21, 27, 33, 39, 45, 51, 57], send_at_hour: 11, sort: 60,
    message_body_template: `Hey {{customer.first_name|there}}, {{rep.first_name|just}} checking in — how's the {{vehicle.model|vehicle}} treating you? Anything you need a hand with, I'm around.` },
  { key: 'lifecycle_even', name: 'Quarterly Pulse — Service / Anniversary (even months)', category: 'retention', trigger_event: 'delivered', channel: 'email', sender_identity: 'dynamic_smart_switch', interval_months: [6, 12, 18, 24, 30, 36, 42, 48, 54, 60], send_at_hour: 10, sort: 70,
    subject_template: `A little something for your {{vehicle.model|vehicle}}`,
    message_body_template: `Hi {{customer.first_name|there}},\n\nThanks for trusting {{dealership.name}} with your {{vehicle.ymm|vehicle}}. As a thank-you, here's a service offer for your next visit — book online at {{service_url|our website}}.\n\nWe appreciate you!` },

  // C. Reviews & referrals
  { key: 'review_48h', name: '48-Hour Review Request', category: 'reviews', trigger_event: 'delivered', channel: 'sms', delay_minutes: 2880, send_at_hour: 12, sender_identity: 'house', sort: 80,
    message_body_template: `Hi {{customer.first_name|there}}, thanks again for choosing {{dealership.name}}! If you have 30 seconds, a quick Google review would mean the world to us: {{review_url|our review page}}` },
  { key: 'referral_day14', name: 'Day 14 Referral Pitch', category: 'referrals', trigger_event: 'delivered', channel: 'sms', delay_minutes: 20160, send_at_hour: 11, sender_identity: 'rep', sort: 90,
    message_body_template: `{{customer.first_name|Hey}} — hope you're loving the {{vehicle.model|new ride}}! Quick one: we pay {{referral_bonus|a referral bonus}} for anyone you send our way who buys. Know a friend or family member in the market? Send them to me directly. — {{rep.first_name|Your team}}` },
  { key: 'referral_month12', name: 'Month 12 Referral Pitch', category: 'referrals', trigger_event: 'delivered', channel: 'email', delay_minutes: 525600, send_at_hour: 10, sender_identity: 'rep', sort: 100,
    subject_template: `Know anyone car shopping? There's {{referral_bonus|a bonus}} in it`,
    message_body_template: `Hi {{customer.first_name|there}},\n\nIt's been a year with your {{vehicle.ymm|vehicle}} — time flies! If you know anyone shopping for a vehicle, send them my way: we'll take great care of them, and you'll get {{referral_bonus|a referral bonus}} when they buy.\n\nThanks for being a loyal customer.\n{{rep.first_name|Your sales team}}` },

  // E. Equity mining / lease pull-ahead
  { key: 'pull_ahead', name: 'Lease Pull-Ahead', category: 'equity', trigger_event: 'equity', channel: 'sms', delay_minutes: 2, sender_identity: 'rep', sort: 105,
    message_body_template: `Hi {{customer.first_name|there}}, it's {{rep.first_name|the team}} at {{dealership.name}}. Good news on your {{vehicle.ymm|vehicle}} — you may be in a strong equity position and could get into a brand-new one for a similar (or lower) payment, early. Want me to run the exact numbers for you? No obligation.` },

  // D. Calendar triggers
  { key: 'birthday', name: 'Birthday Greeting', category: 'calendar', trigger_event: 'birthday', channel: 'sms', delay_minutes: 0, send_at_hour: 9, sender_identity: 'rep', sort: 110,
    message_body_template: `Happy Birthday, {{customer.first_name|there}}! 🎉 Hope you have a great one. — {{rep.first_name|Your friends}} at {{dealership.name}}` },
  { key: 'holiday', name: 'Holiday Greeting', category: 'calendar', trigger_event: 'holiday', channel: 'email', delay_minutes: 0, send_at_hour: 9, sender_identity: 'house', sort: 120,
    subject_template: `Happy {{holiday.name|Holidays}} from {{dealership.name}}`,
    message_body_template: `Wishing you and your family a wonderful {{holiday.name|holiday season}} from all of us at {{dealership.name}}. Please note our holiday service hours may vary — check {{service_url|our website}} before stopping by. Thank you for being part of our community!` },

  // F. Sales-rep TASK cadences — instead of messaging the customer, drop a
  //    follow-up task on the assigned rep's list. Off by default; toggle on.
  { key: 'task_next_day', name: 'Next-Day Reach-Out', category: 'tasks', trigger_event: 'internet_lead', channel: 'task', delay_minutes: 1440, sender_identity: 'rep', is_active: false, sort: 130,
    message_body_template: `Day-1 personal follow-up — call or text this lead.` },
  { key: 'task_day30', name: '30-Day Follow-Up', category: 'tasks', trigger_event: 'internet_lead', channel: 'task', delay_minutes: 43200, sender_identity: 'rep', is_active: false, sort: 140,
    message_body_template: `30-day check-in — still shopping? Re-engage.` },
  { key: 'task_day90', name: '90-Day Follow-Up', category: 'tasks', trigger_event: 'internet_lead', channel: 'task', delay_minutes: 129600, sender_identity: 'rep', is_active: false, sort: 150,
    message_body_template: `90-day check-in — long-term nurture touch.` },
]

// Seed the default campaigns for a dealership the first time (idempotent).
async function ensureCampaigns(dealershipId) {
  if (!dealershipId) return
  const { data: existing } = await supabaseAdmin.from('automated_campaigns').select('key').eq('dealership_id', dealershipId)
  const have = new Set((existing || []).map(c => c.key))
  const missing = DEFAULT_CAMPAIGNS.filter(c => !have.has(c.key)).map(c => ({ ...c, dealership_id: dealershipId }))
  if (!missing.length) return
  // Batch insert first; if it fails (e.g. one row trips a CHECK constraint, which
  // used to atomically wipe the ENTIRE seed and leave the dealer with no campaigns),
  // fall back to inserting row-by-row so one bad row never blocks the rest.
  const { error } = await supabaseAdmin.from('automated_campaigns').insert(missing)
  if (error) {
    console.error('[ensureCampaigns] batch insert failed, retrying per-row:', error.message)
    for (const row of missing) {
      const { error: e1 } = await supabaseAdmin.from('automated_campaigns').insert(row)
      if (e1) console.error(`[ensureCampaigns] skipped "${row.key}" (${row.channel}/${row.trigger_event}): ${e1.message}`)
    }
  }
}

// ── Time helpers ─────────────────────────────────────────────────────────────
function addMonths(date, months) { const d = new Date(date); d.setMonth(d.getMonth() + months); return d }
// Move a timestamp to a given local hour; if the resulting time isn't strictly
// after `after`, push it to the next day (so "morning after" lands tomorrow).
function alignHour(date, hour, forceNextDay, after) {
  const d = new Date(date); d.setHours(hour, 0, 0, 0)
  const floor = after ? new Date(after) : null
  if (forceNextDay || (floor && d <= floor)) d.setDate(d.getDate() + 1)
  return d
}
function localHour(tz) {
  try { return parseInt(new Intl.DateTimeFormat('en-US', { timeZone: tz || 'America/Toronto', hour: 'numeric', hour12: false }).format(new Date()), 10) } catch { return new Date().getHours() }
}
function dealerSettings(dealer) {
  const s = (dealer?.automation_settings && typeof dealer.automation_settings === 'object') ? dealer.automation_settings : {}
  return {
    timezone: s.timezone || 'America/Toronto',
    business_start: Number.isFinite(s.business_start) ? s.business_start : 8,
    business_end: Number.isFinite(s.business_end) ? s.business_end : 19,
    house_sms: s.house_sms || null,
    house_email: s.house_email || dealer?.branding?.email || null,
    review_url: s.review_url || null,
    referral_bonus: s.referral_bonus || 'a referral bonus',
    service_url: s.service_url || (dealer?.branding?.email ? null : null),
    holidays: Array.isArray(s.holidays) ? s.holidays : [],
    // Proactive morning briefing: in-app for managers by default; email opt-in.
    digest_enabled: s.digest_enabled !== false,
    digest_email: s.digest_email === true,
    // Proactive WEEKLY briefing: AI-written strategic recap. Configurable day + email.
    weekly_enabled: s.weekly_enabled !== false,
    weekly_email: s.weekly_email === true,
    weekly_day: Number.isInteger(s.weekly_day) && s.weekly_day >= 0 && s.weekly_day <= 6 ? s.weekly_day : 1,  // 0=Sun … 1=Mon
    weekly_focus: typeof s.weekly_focus === 'string' ? s.weekly_focus.slice(0, 600) : null,
    enabled: s.enabled !== false,
    email: (s.email && typeof s.email === 'object') ? {
      from_name: s.email.from_name || null,
      from: s.email.from || null,
      reply_to: s.email.reply_to || null,
      sender_mode: ['house', 'rep', 'both'].includes(s.email.sender_mode) ? s.email.sender_mode : 'house',
      track_to_tasks: s.email.track_to_tasks !== false,
    } : { from_name: null, from: null, reply_to: null, sender_mode: 'house', track_to_tasks: true },
  }
}
const isBusinessHours = (s) => { const h = localHour(s.timezone); return h >= s.business_start && h < s.business_end }

// ── Templating (safe fallbacks — never emits a raw {{tag}}) ───────────────────
function renderTemplate(tmpl, vars) {
  return String(tmpl || '').replace(/\{\{\s*([\w.]+)\s*(?:\|\s*([^}]*))?\}\}/g, (_, key, fb) => {
    const v = vars[key]
    if (v != null && String(v).trim() !== '') return String(v)
    return fb != null ? fb.trim() : ''
  })
}
function buildVars(contact, vehicle, rep, dealer, s) {
  const first = contact.first_name || String(contact.full_name || '').trim().split(/\s+/)[0] || ''
  const repName = rep?.display_name || rep?.full_name || ''
  return {
    'customer.first_name': first,
    'customer.last_name': contact.last_name || '',
    'customer.full_name': contact.full_name || first,
    'vehicle.year': vehicle?.year || '',
    'vehicle.make': vehicle?.make || '',
    'vehicle.model': vehicle?.model || '',
    'vehicle.trim': vehicle?.trim || '',
    'vehicle.ymm': [vehicle?.year, vehicle?.make, vehicle?.model].filter(Boolean).join(' '),
    'rep.first_name': repName.split(/\s+/)[0] || '',
    'rep.full_name': repName,
    'dealership.name': dealer?.name || 'our dealership',
    'dealership.phone': s.house_sms || dealer?.branding?.phone || '',
    'review_url': s.review_url || '',
    'referral_bonus': s.referral_bonus || 'a referral bonus',
    'service_url': s.service_url || (dealer?.site_slug ? `https://marketsync.link/site.html?d=${dealer.site_slug}` : 'our website'),
  }
}

// ── Enqueue: trigger → scheduled_messages ────────────────────────────────────
// ctx: { contactId, vehicleId, repId, baseAt }. Multi-interval campaigns fan out
// into one row per marker. Upsert dedupes on (contact, campaign, marker).
export async function enqueueForTrigger(dealershipId, trigger, ctx = {}) {
  try {
    if (!dealershipId || !ctx.contactId) return
    await ensureCampaigns(dealershipId)
    const { data: dealer } = await supabaseAdmin.from('dealerships').select('automation_settings').eq('id', dealershipId).maybeSingle()
    if (!dealerSettings(dealer).enabled) return
    const { data: camps } = await supabaseAdmin.from('automated_campaigns')
      .select('*').eq('dealership_id', dealershipId).eq('trigger_event', trigger).eq('is_active', true)
    if (!camps?.length) return
    const base = ctx.baseAt ? new Date(ctx.baseAt) : new Date()
    const year = base.getFullYear()
    const rows = []
    for (const c of camps) {
      const markers = (c.interval_months && c.interval_months.length) ? c.interval_months : [null]
      for (const m of markers) {
        let at
        if (m != null) at = addMonths(base, m)
        else at = new Date(base.getTime() + (c.delay_minutes || 0) * 60000)
        if (c.send_at_hour != null) at = alignHour(at, c.send_at_hour, false, base.getTime() + (c.delay_minutes || 0) * 60000)
        // Calendar campaigns dedupe once per year (birthday) or per-holiday-per-year
        // (holiday, via a markerOverride like year*10000 + MMDD) via the marker.
        const marker = m != null ? m : (ctx.markerOverride != null ? ctx.markerOverride : ((trigger === 'birthday' || trigger === 'holiday') ? year : null))
        rows.push({
          dealership_id: dealershipId, contact_id: ctx.contactId, vehicle_id: ctx.vehicleId || null, rep_id: ctx.repId || null,
          campaign_id: c.id, sequence_key: `${trigger}:${c.key || c.id}`, interval_marker: marker,
          channel: c.channel, sender_identity: c.sender_identity, scheduled_at: at.toISOString(), status: 'pending',
          context: ctx.context || null,
        })
      }
    }
    if (rows.length) await supabaseAdmin.from('scheduled_messages').upsert(rows, { onConflict: 'contact_id,campaign_id,interval_marker', ignoreDuplicates: true })
  } catch (e) { console.warn('[automation] enqueue failed:', e.message) }
}

// Delivery is the spine of retention: record ownership, then fan out the lifecycle.
export async function markDelivered(dealershipId, contactId, vehicleId, repId, deliveryDate) {
  try {
    if (!dealershipId || !contactId) return
    const when = deliveryDate ? new Date(deliveryDate) : new Date()
    await supabaseAdmin.from('customer_ownership_tracking').upsert({
      dealership_id: dealershipId, customer_id: contactId, vehicle_id: vehicleId || null,
      owns_vehicle: true, vehicle_status: 'delivered', delivery_date: when.toISOString(), updated_at: nowIso(),
    }, { onConflict: 'customer_id,vehicle_id' })
    await enqueueForTrigger(dealershipId, 'delivered', { contactId, vehicleId, repId, baseAt: when })
    // Possession gate (#16): delivering this customer's deal means we now have their
    // trade in hand → release any acquired trade unit tied to their appraisal to the site.
    await releasePossessionForContact(dealershipId, contactId, when).catch(() => {})
  } catch (e) { console.warn('[automation] markDelivered failed:', e.message) }
}

// When a contact's deal is delivered, any trade they gave us is now in the dealer's
// possession — flip its acquired inventory unit live on the website (#16).
async function releasePossessionForContact(dealershipId, contactId, when) {
  if (!dealershipId || !contactId) return
  const { data: aps } = await supabaseAdmin.from('trade_appraisals')
    .select('id, inventory_id').eq('dealership_id', dealershipId).eq('contact_id', contactId)
    .not('inventory_id', 'is', null)
  const invIds = [...new Set((aps || []).map(a => a.inventory_id).filter(Boolean))]
  if (!invIds.length) return
  const at = (when ? new Date(when) : new Date()).toISOString()
  await supabaseAdmin.from('inventory')
    .update({ awaiting_possession: false, possession_at: at })
    .in('id', invIds).eq('dealership_id', dealershipId).eq('awaiting_possession', true)
  await supabaseAdmin.from('trade_appraisals')
    .update({ acquired_at: at }).in('id', (aps || []).map(a => a.id))
}

// ── Drop-out: an inbound reply freezes every running sequence for the contact ──
export async function freezeSequences(contactId, reason = 'customer_replied') {
  if (!contactId) return
  try {
    await supabaseAdmin.from('scheduled_messages')
      .update({ status: 'cancelled', cancel_reason: reason, verified_at: nowIso() })
      .eq('contact_id', contactId).eq('status', 'pending')
    // Flag for the rep and pause future automated touches until they re-engage.
    const { data: c } = await supabaseAdmin.from('contacts').select('tags').eq('id', contactId).maybeSingle()
    const tags = Array.isArray(c?.tags) ? c.tags : []
    if (!tags.includes('rep_action_required')) tags.push('rep_action_required')
    await supabaseAdmin.from('contacts').update({ tags, automation_paused: true, last_activity_at: nowIso() }).eq('id', contactId)
  } catch (e) { console.warn('[automation] freeze failed:', e.message) }
}

// ── Sender identity resolution (house / rep / dynamic smart switch + orphan) ──
async function resolveSender(campaign, contact, dealer, s) {
  // Dealer-wide sender mode (Automation → Settings) is the master switch: house =
  // dealership general email, rep = the salesperson's, both = rep with the
  // dealership on reply-to. When unset, the campaign's own choice stands.
  const mode = s.email?.sender_mode
  let identity = campaign.sender_identity || 'house'
  if (mode === 'house') identity = 'house'
  else if (mode === 'rep' || mode === 'both') identity = 'rep'
  if (identity === 'dynamic_smart_switch') identity = isBusinessHours(s) ? 'rep' : 'house'
  let rep = null
  if (identity === 'rep') {
    const repId = contact.assigned_rep
    if (repId) {
      const { data } = await supabaseAdmin.from('profiles').select('id, full_name, display_name, phone, sms_number, business_email, active, orphan_rep_id').eq('id', repId).maybeSingle()
      rep = data || null
    }
    // Orphan-owner rule: inactive/terminated rep → inherit orphan rep, else house.
    if (!rep || rep.active === false) {
      const orphanId = rep?.orphan_rep_id
      if (orphanId) {
        const { data } = await supabaseAdmin.from('profiles').select('id, full_name, display_name, phone, sms_number, business_email, active').eq('id', orphanId).maybeSingle()
        rep = (data && data.active !== false) ? data : null
      } else rep = null
      if (!rep) identity = 'house'
    }
  }
  const smsFrom = identity === 'rep' ? (rep?.sms_number || s.house_sms) : s.house_sms
  // Professional "from" — prefer the configured email-setup identity, then the
  // legacy house_email, then the platform default.
  const houseEmail = s.email?.from || s.house_email
  const houseName = s.email?.from_name || dealer?.name
  const houseFrom = houseEmail ? `${houseName} <${houseEmail}>` : EMAIL_FROM
  const emailFrom = identity === 'rep'
    ? (rep?.business_email ? `${rep.display_name || rep.full_name} <${rep.business_email}>` : houseFrom)
    : houseFrom
  // 'both' routes replies to the dealership general inbox so every thread is
  // centrally tracked even when it's sent from the rep.
  const replyTo = s.email?.reply_to || (mode === 'both' ? houseEmail : null)
  return { identity, rep, smsFrom, emailFrom, replyTo, plaintext: identity === 'rep' }
}

// ── Kill-switch verification (runs at dispatch AND 1h prior) ──────────────────
// Returns { action: 'send' | 'cancel' | 'pause', reason }.
async function verify(msg, campaign) {
  const { data: contact } = await supabaseAdmin.from('contacts')
    .select('id, status, dnc, opt_out, consent_sms, consent_email, delivery_issue, automation_paused, assigned_rep, interest_inventory_id')
    .eq('id', msg.contact_id).maybeSingle()
  if (!contact) return { action: 'cancel', reason: 'contact_missing' }

  // Hard stops
  if (contact.opt_out || contact.dnc) return { action: 'cancel', reason: 'opted_out' }
  if (msg.channel === 'sms' && contact.consent_sms === false) return { action: 'cancel', reason: 'no_sms_consent' }
  if (msg.channel === 'email' && contact.consent_email === false) return { action: 'cancel', reason: 'no_email_consent' }

  // Drop-out freeze (a reply set automation_paused). Retention/calendar halt; a
  // fresh pipeline touch is also suppressed so we never talk over a live human.
  if (contact.automation_paused) return { action: 'cancel', reason: 'customer_replied' }

  const cat = campaign?.category
  const retentionish = ['retention', 'reviews', 'referrals'].includes(cat)

  // Ownership check — retention/review/referral only fire while they still own it.
  if (retentionish) {
    const { data: own } = await supabaseAdmin.from('customer_ownership_tracking')
      .select('owns_vehicle, vehicle_status').eq('customer_id', msg.contact_id)
      .eq('vehicle_id', msg.vehicle_id || '00000000-0000-0000-0000-000000000000').maybeSingle()
    if (own && (own.owns_vehicle === false || ['traded_in', 'sold_private', 'totaled'].includes(own.vehicle_status)))
      return { action: 'cancel', reason: 'ownership_lost' }
  }

  // Active pipeline exception — pause long-term retention during an open deal.
  if (cat === 'retention' && OPEN_DEAL_STATUSES.has(String(contact.status || '').toLowerCase()) && contact.status !== 'delivered')
    return { action: 'pause', reason: 'active_deal' }

  // Bad-review diverter — never ask an unhappy delivery for a public review.
  if (cat === 'reviews' && contact.delivery_issue) return { action: 'cancel', reason: 'delivery_issue' }

  return { action: 'send', reason: null }
}

// ── Dispatch (SMS via Twilio if configured, email via Resend) ─────────────────
// A dealer can bring their own Twilio account (Settings → Integrations → Twilio):
// SID + token are stored encrypted, the from-number in lender_code_map. When present,
// their account/number is used so texts come from their own A2P-registered number;
// otherwise we fall back to the shared MarketSync Twilio env vars.
const __twilioCache = new Map()   // dealershipId → { creds, at }
async function dealerTwilio(dealershipId) {
  if (!dealershipId) return null
  const hit = __twilioCache.get(dealershipId)
  if (hit && Date.now() - hit.at < 60000) return hit.creds
  let creds = null
  try {
    const { data: row } = await supabaseAdmin.from('dealer_integrations')
      .select('enabled, credentials_enc, lender_code_map')
      .eq('dealership_id', dealershipId).eq('provider', 'twilio').maybeSingle()
    if (row?.enabled && row.credentials_enc) {
      const dec = decryptJson(row.credentials_enc) || {}
      if (dec.account_sid && dec.auth_token) {
        creds = { sid: dec.account_sid, tok: dec.auth_token, from: row.lender_code_map?.from || null }
      }
    }
  } catch (e) { console.warn('[twilio] resolve failed:', e.message) }
  __twilioCache.set(dealershipId, { creds, at: Date.now() })
  return creds
}
export function invalidateTwilioCache(dealershipId) { if (dealershipId) __twilioCache.delete(dealershipId) }

async function sendSms(to, body, from, creds) {
  const sid = creds?.sid || process.env.TWILIO_ACCOUNT_SID
  const tok = creds?.tok || process.env.TWILIO_AUTH_TOKEN
  const fromNum = from || creds?.from
  if (!sid || !tok || !fromNum || !to) return { ok: false, simulated: true }
  try {
    const params = new URLSearchParams({ To: to, From: fromNum, Body: body })
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${tok}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' }, body: params,
    })
    const j = await r.json().catch(() => ({}))
    return { ok: r.ok, sid: j.sid, error: j.message }
  } catch (e) { return { ok: false, error: e.message } }
}

// Send an SMS for a dealership using its own Twilio account when connected.
export async function sendDealerSms(dealershipId, to, body, from = null) {
  const creds = await dealerTwilio(dealershipId)
  return sendSms(to, body, from, creds)
}

async function dispatch(msg, campaign) {
  const [{ data: contact }, { data: dealer }] = await Promise.all([
    supabaseAdmin.from('contacts').select('*').eq('id', msg.contact_id).maybeSingle(),
    supabaseAdmin.from('dealerships').select('id, name, site_slug, branding, automation_settings').eq('id', msg.dealership_id).maybeSingle(),
  ])
  if (!contact || !dealer) { await supabaseAdmin.from('scheduled_messages').update({ status: 'cancelled', cancel_reason: 'missing_records', verified_at: nowIso() }).eq('id', msg.id); return }
  const s = dealerSettings(dealer)
  const vehicle = msg.vehicle_id ? (await supabaseAdmin.from('inventory').select('year, make, model, trim').eq('id', msg.vehicle_id).maybeSingle()).data : null
  const sender = await resolveSender(campaign, contact, dealer, s)
  const ctx = (msg.context && typeof msg.context === 'object') ? msg.context : {}
  const vars = { ...buildVars(contact, vehicle, sender.rep, dealer, s), ...(ctx.vars || {}) }

  // Per-send overrides (e.g. a specific holiday's message) win over the campaign template.
  let subject = (ctx.subject_override != null ? renderTemplate(ctx.subject_override, vars) : (campaign.subject_template ? renderTemplate(campaign.subject_template, vars) : null))
  let body = renderTemplate(ctx.body_override != null ? ctx.body_override : campaign.message_body_template, vars)

  // TCPA / A2P 10DLC: opt-out disclosure ONLY on the first automated touch per
  // channel — suppressed afterwards so threads read like a real person texting.
  let disclosurePatch = null
  if (msg.channel === 'sms' && !contact.sms_disclosed) { body += '\n\nReply STOP to opt out.'; disclosurePatch = { sms_disclosed: true } }
  if (msg.channel === 'email' && !contact.email_disclosed) { disclosurePatch = { email_disclosed: true } }

  let result = { ok: false }
  if (msg.channel === 'sms') {
    const to = contact.phone || contact.phone_mobile
    const twilio = await dealerTwilio(msg.dealership_id)
    result = await sendSms(to, body, sender.smsFrom, twilio)
  } else {
    if (!resend) result = { ok: false, simulated: true }
    else if (contact.email) {
      // rep identity → plaintext, no banners/pixels. house → light branded HTML.
      const payload = { from: sender.emailFrom, to: contact.email, subject: subject || `A note from ${dealer.name}` }
      if (sender.replyTo) payload.reply_to = sender.replyTo
      if (sender.plaintext) payload.text = body
      else payload.html = `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:15px;color:#0f172a;line-height:1.6">${body.replace(/\n/g, '<br>')}<hr style="border:none;border-top:1px solid #e2e8f0;margin:18px 0"><div style="font-size:12px;color:#94a3b8">${dealer.name}${s.house_email ? ' · ' + s.house_email : ''}</div></div>`
      try { const r = await resend.emails.send(payload); result = { ok: !r.error, error: r.error?.message } } catch (e) { result = { ok: false, error: e.message } }
    } else result = { ok: false, error: 'no_email' }
  }

  const sent = result.ok || result.simulated
  await supabaseAdmin.from('scheduled_messages').update({
    status: sent ? 'sent' : 'cancelled', sent_at: sent ? nowIso() : null, verified_at: nowIso(),
    cancel_reason: sent ? null : (result.error || 'send_failed'), rendered_subject: subject, rendered_body: body,
    sender_identity: sender.identity,
  }).eq('id', msg.id)

  if (sent) {
    if (disclosurePatch) await supabaseAdmin.from('contacts').update(disclosurePatch).eq('id', contact.id)
    try {
      await supabaseAdmin.from('communications').insert({
        dealership_id: msg.dealership_id, contact_id: contact.id, channel: msg.channel, direction: 'outbound',
        subject, body, rep_id: sender.identity === 'rep' ? (sender.rep?.id || null) : null,
        meta: { automated: true, campaign: campaign.key || campaign.id, sender_identity: sender.identity, simulated: !!result.simulated },
      })
      await supabaseAdmin.from('contacts').update({ last_activity_at: nowIso() }).eq('id', contact.id)
    } catch {}
  }
  return sent
}

// ── Background worker ─────────────────────────────────────────────────────────
// runDue: dispatch everything past its scheduled_at (verifying each first).
// A "task" campaign creates a CRM follow-up task for the assigned rep.
async function createRepTask(msg, campaign) {
  try {
    const { data: contact } = await supabaseAdmin.from('contacts')
      .select('first_name, full_name, status').eq('id', msg.contact_id).maybeSingle()
    if (!contact) {
      await supabaseAdmin.from('scheduled_messages').update({ status: 'cancelled', cancel_reason: 'missing_contact', verified_at: nowIso() }).eq('id', msg.id)
      return false
    }
    // Don't nag on closed/won records with a "still shopping?" task.
    if (['sold', 'fni', 'delivered', 'lost', 'dead'].includes(contact.status)) {
      await supabaseAdmin.from('scheduled_messages').update({ status: 'cancelled', cancel_reason: 'deal_closed', verified_at: nowIso() }).eq('id', msg.id)
      return false
    }
    const who = contact.first_name || contact.full_name || 'lead'
    const title = `${campaign.name || 'Follow-up'}: ${who}`
    // Tag the task by journey so the CRM can colour it — green for post-delivery
    // retention, orange for new-lead follow-up.
    const deliveryBuckets = ['retention', 'reviews', 'referrals']
    const isDelivery = campaign.trigger_event === 'delivered' || deliveryBuckets.includes(campaign.category)
    const taskType = isDelivery ? 'delivery_followup' : 'lead_followup'
    await supabaseAdmin.from('crm_tasks').insert({
      dealership_id: msg.dealership_id, contact_id: msg.contact_id, assigned_to: msg.rep_id || null,
      title, type: taskType, due_at: nowIso(),
    })
    await supabaseAdmin.from('scheduled_messages').update({ status: 'sent', sent_at: nowIso(), verified_at: nowIso() }).eq('id', msg.id)
    return true
  } catch (e) { console.warn('[automation] rep task create failed:', e.message); return false }
}

export async function runDue(limit = 200) {
  const { data: due } = await supabaseAdmin.from('scheduled_messages')
    .select('*').eq('status', 'pending').lte('scheduled_at', nowIso()).order('scheduled_at').limit(limit)
  let sent = 0, cancelled = 0, paused = 0
  for (const msg of (due || [])) {
    const { data: campaign } = await supabaseAdmin.from('automated_campaigns').select('*').eq('id', msg.campaign_id).maybeSingle()
    if (!campaign || !campaign.is_active) { await supabaseAdmin.from('scheduled_messages').update({ status: 'cancelled', cancel_reason: 'campaign_off', verified_at: nowIso() }).eq('id', msg.id); cancelled++; continue }
    // Task cadences drop a follow-up on the rep instead of messaging the customer;
    // consent/quiet-hours checks don't apply to an internal task.
    if (campaign.channel === 'task') { if (await createRepTask(msg, campaign)) sent++; else cancelled++; continue }
    const v = await verify(msg, campaign)
    if (v.action === 'cancel') { await supabaseAdmin.from('scheduled_messages').update({ status: 'cancelled', cancel_reason: v.reason, verified_at: nowIso() }).eq('id', msg.id); cancelled++; continue }
    if (v.action === 'pause') { await supabaseAdmin.from('scheduled_messages').update({ status: 'paused', cancel_reason: v.reason, verified_at: nowIso() }).eq('id', msg.id); paused++; continue }
    if (await dispatch(msg, campaign)) sent++; else cancelled++
  }
  return { processed: (due || []).length, sent, cancelled, paused }
}

// runPrecheck: 1-hour-prior sweep — cancel/pause messages that already fail the
// kill switches so they never even reach the dispatch window.
export async function runPrecheck(limit = 500) {
  const horizon = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  const { data: soon } = await supabaseAdmin.from('scheduled_messages')
    .select('*').eq('status', 'pending').gt('scheduled_at', nowIso()).lte('scheduled_at', horizon).limit(limit)
  let cancelled = 0, paused = 0
  for (const msg of (soon || [])) {
    const { data: campaign } = await supabaseAdmin.from('automated_campaigns').select('*').eq('id', msg.campaign_id).maybeSingle()
    if (!campaign) continue
    const v = await verify(msg, campaign)
    if (v.action === 'cancel') { await supabaseAdmin.from('scheduled_messages').update({ status: 'cancelled', cancel_reason: v.reason, verified_at: nowIso() }).eq('id', msg.id); cancelled++ }
    else if (v.action === 'pause') { await supabaseAdmin.from('scheduled_messages').update({ status: 'paused', cancel_reason: v.reason, verified_at: nowIso() }).eq('id', msg.id); paused++ }
  }
  return { checked: (soon || []).length, cancelled, paused }
}

// ── Floating-holiday date math ───────────────────────────────────────────────
// Many holidays aren't a fixed MM-DD (Thanksgiving, Labour/Labor Day, Victoria
// Day, Family Day, Good Friday…). We store an optional `rule` and resolve the
// real date for the current year so greetings never drift year to year.
function _pad2(n) { return String(n).padStart(2, '0') }
function _mmddOf(dt) { return `${_pad2(dt.getUTCMonth() + 1)}-${_pad2(dt.getUTCDate())}` }
function easterSunday(year) { // Anonymous Gregorian computus (UTC)
  const a = year % 19, b = Math.floor(year / 100), c = year % 100
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)          // 3=Mar, 4=Apr
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return new Date(Date.UTC(year, month - 1, day))
}
function nthWeekday(year, month, weekday, n) { // month 1-12, weekday 0=Sun..6=Sat, n 1-5
  const first = new Date(Date.UTC(year, month - 1, 1))
  const shift = (weekday - first.getUTCDay() + 7) % 7
  return new Date(Date.UTC(year, month - 1, 1 + shift + (n - 1) * 7))
}
function lastWeekday(year, month, weekday) {
  const last = new Date(Date.UTC(year, month, 0))              // last day of the month
  const shift = (last.getUTCDay() - weekday + 7) % 7
  return new Date(Date.UTC(year, month - 1, last.getUTCDate() - shift))
}
function mondayBefore(year, month, day) {                       // latest Monday strictly before month-day
  const dt = new Date(Date.UTC(year, month - 1, day))
  let back = (dt.getUTCDay() + 6) % 7                           // days back to this week's Monday
  if (back === 0) back = 7                                      // strictly before → previous Monday
  return new Date(Date.UTC(year, month - 1, day - back))
}
function resolveHolidayMMDD(h, year) {
  const rule = h && h.rule ? String(h.rule) : ''
  if (!rule) return String(h && h.date || '').slice(0, 5)
  const p = rule.split(':')
  try {
    if (p[0] === 'nth') return _mmddOf(nthWeekday(year, +p[3], +p[1], +p[2]))
    if (p[0] === 'last') return _mmddOf(lastWeekday(year, +p[2], +p[1]))
    if (p[0] === 'monbefore') { const [mm, dd] = p[1].split('-').map(Number); return _mmddOf(mondayBefore(year, mm, dd)) }
    if (p[0] === 'easter') { const e = easterSunday(year); e.setUTCDate(e.getUTCDate() + (+p[1] || 0)); return _mmddOf(e) }
  } catch {}
  return String(h && h.date || '').slice(0, 5)
}

// ── Contact geo → country, so a US customer never gets Canada's October
// Thanksgiving (and a CA customer never gets US November Thanksgiving). Falls
// back to the dealership's own country/province when the contact has no address.
const US_STATE_SET = new Set(['al', 'ak', 'az', 'ar', 'ca', 'co', 'ct', 'de', 'fl', 'ga', 'hi', 'id', 'il', 'in', 'ia', 'ks', 'ky', 'la', 'me', 'md', 'ma', 'mi', 'mn', 'ms', 'mo', 'mt', 'ne', 'nv', 'nh', 'nj', 'nm', 'ny', 'nc', 'nd', 'oh', 'ok', 'or', 'pa', 'ri', 'sc', 'sd', 'tn', 'tx', 'ut', 'vt', 'va', 'wa', 'wv', 'wi', 'wy', 'dc'])
const CA_PROV_SET = new Set(['ab', 'bc', 'mb', 'nb', 'nl', 'ns', 'nt', 'nu', 'on', 'pe', 'qc', 'sk', 'yt'])
function normCountry(v) {
  const c = String(v || '').toLowerCase().trim()
  if (!c) return null
  if (/(^us$|^usa$|united states|america)/.test(c)) return 'US'
  if (/(^ca$|^can$|canada)/.test(c)) return 'CA'
  return null
}
function contactCountry(c, fallback) {
  return normCountry(c.country)
    || (US_STATE_SET.has(String(c.province || '').toLowerCase().trim()) ? 'US' : null)
    || (CA_PROV_SET.has(String(c.province || '').toLowerCase().trim()) ? 'CA' : null)
    || (/^[a-z]\d[a-z]/i.test(String(c.postal_code || '').trim()) ? 'CA' : null)
    || (/^\d{5}(-\d{4})?$/.test(String(c.postal_code || '').trim()) ? 'US' : null)
    || fallback || null
}

// Daily scan: birthdays + configured holidays across all dealerships.
async function runDaily() {
  const { data: dealers } = await supabaseAdmin.from('dealerships').select('id, automation_settings, site_slug, province, country')
  const today = new Date(); const mmdd = `${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  let birthdays = 0, holidays = 0
  for (const d of (dealers || [])) {
    const s = dealerSettings(d); if (!s.enabled) continue
    // Birthdays — match month/day, respect consent, dedupe once/year via enqueue.
    const { data: contacts } = await supabaseAdmin.from('contacts')
      .select('id, birthday, assigned_rep, consent_sms, dnc, opt_out').eq('dealership_id', d.id).not('birthday', 'is', null)
    for (const c of (contacts || [])) {
      if (c.dnc || c.opt_out || c.consent_sms === false) continue
      const b = String(c.birthday).slice(5, 10) // MM-DD from YYYY-MM-DD
      if (b === mmdd) { await enqueueForTrigger(d.id, 'birthday', { contactId: c.id, repId: c.assigned_rep }); birthdays++ }
    }
    // Holidays — dealer-configured [{name, date:'MM-DD', rule, country, enabled, …}].
    // Floating dates resolve by rule for the current year; each greeting only goes
    // to customers in its country so nobody gets the wrong nation's Thanksgiving.
    const year = today.getFullYear()
    const todaysHolidays = (s.holidays || []).filter(h => h.enabled !== false && resolveHolidayMMDD(h, year) === mmdd)
    if (todaysHolidays.length) {
      const { data: emailable } = await supabaseAdmin.from('contacts').select('id, assigned_rep, consent_email, dnc, opt_out, country, province, postal_code').eq('dealership_id', d.id).not('email', 'is', null)
      const dealerFallback = normCountry(d.country) || (US_STATE_SET.has(String(d.province || '').toLowerCase().trim()) ? 'US' : CA_PROV_SET.has(String(d.province || '').toLowerCase().trim()) ? 'CA' : null)
      const mmddInt = (today.getMonth() + 1) * 100 + today.getDate()
      for (const h of todaysHolidays) {
        const only = (h.country === 'CA' || h.country === 'US') ? h.country : null   // null = everyone
        const context = { vars: { 'holiday.name': h.name || 'the holidays' }, body_override: h.message || null, subject_override: h.subject || null }
        const markerOverride = year * 10000 + mmddInt   // one per holiday-date per year
        for (const c of (emailable || [])) {
          if (c.dnc || c.opt_out || c.consent_email === false) continue
          if (only && contactCountry(c, dealerFallback) !== only) continue   // geo-gate country-specific greetings
          await enqueueForTrigger(d.id, 'holiday', { contactId: c.id, repId: c.assigned_rep, context, markerOverride }); holidays++
        }
      }
    }
  }
  return { birthdays, holidays }
}

// ── Proactive morning briefing ───────────────────────────────────────────────
// Pushes the "what needs attention today" digest to managers instead of waiting to
// be asked. Same signals the AI brain's `priorities`/`trends` topics surface, kept
// self-contained here (no cross-import) and cheap. In-app for every manager; a nicely
// formatted email too when the dealer opted in. Idempotent per dealer per day.
async function buildDigest(dealershipId) {
  const now = Date.now(), d = new Date()
  const nowIso = new Date().toISOString()
  const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).toISOString()
  const d7 = new Date(now - 7 * 86400000).toISOString()
  const d14 = new Date(now - 14 * 86400000).toISOString()
  const todayEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59).toISOString()
  const money = n => '$' + Math.round(Number(n) || 0).toLocaleString('en-US')

  const [uncontacted, overdue, appts, inv, soldDeals, mtdDeals, leads] = await Promise.all([
    supabaseAdmin.from('contacts').select('id', { count: 'exact', head: true }).eq('dealership_id', dealershipId).eq('status', 'uncontacted'),
    supabaseAdmin.from('crm_tasks').select('id', { count: 'exact', head: true }).eq('dealership_id', dealershipId).eq('done', false).lt('due_at', nowIso),
    supabaseAdmin.from('crm_tasks').select('id', { count: 'exact', head: true }).eq('dealership_id', dealershipId).eq('done', false).eq('type', 'appointment').gte('due_at', nowIso).lte('due_at', todayEnd),
    supabaseAdmin.from('inventory').select('created_at, lot_date').eq('dealership_id', dealershipId).eq('status', 'available').limit(2000),
    supabaseAdmin.from('deals').select('id', { count: 'exact', head: true }).eq('dealership_id', dealershipId).eq('deal_status', 'sold'),
    supabaseAdmin.from('deals').select('selling_price, sold_at, created_at, deal_status').eq('dealership_id', dealershipId).in('deal_status', ['sold', 'delivered']).gte('sold_at', monthStart).limit(1000),
    supabaseAdmin.from('leads').select('created_at').eq('dealership_id', dealershipId).gte('created_at', d14).limit(4000),
  ])
  const age = v => { const ref = v.lot_date || v.created_at; return ref ? Math.floor((now - new Date(ref)) / 86400000) : 0 }
  const aged90 = (inv.data || []).filter(v => age(v) >= 90).length
  const aged60 = (inv.data || []).filter(v => age(v) >= 60 && age(v) < 90).length
  const mtd = (mtdDeals.data || []).filter(x => (x.sold_at || x.created_at) >= monthStart)
  const leads7 = (leads.data || []).filter(l => l.created_at >= d7).length
  const leadsPrev7 = (leads.data || []).filter(l => l.created_at < d7).length

  const items = []   // { emoji, text, priority }
  if ((uncontacted.count || 0) > 0) items.push({ emoji: '📞', text: `${uncontacted.count} uncontacted lead(s) need a first touch`, priority: 'high' })
  if ((overdue.count || 0) > 0) items.push({ emoji: '⏰', text: `${overdue.count} overdue follow-up task(s)`, priority: 'high' })
  if (aged90 > 0) items.push({ emoji: '🚨', text: `${aged90} unit(s) 90+ days old — wholesale/auction candidates`, priority: 'high' })
  if (aged60 > 0) items.push({ emoji: '📉', text: `${aged60} unit(s) 60–90 days — consider a price drop`, priority: 'medium' })
  if ((appts.count || 0) > 0) items.push({ emoji: '📅', text: `${appts.count} appointment(s) booked for today`, priority: 'medium' })
  if ((soldDeals.count || 0) > 0) items.push({ emoji: '🚗', text: `${soldDeals.count} sold deal(s) awaiting delivery`, priority: 'medium' })
  const rank = { high: 0, medium: 1, low: 2 }
  items.sort((a, b) => rank[a.priority] - rank[b.priority])

  const leadDelta = leadsPrev7 ? Math.round(((leads7 - leadsPrev7) / leadsPrev7) * 100) : (leads7 ? 100 : 0)
  const pulse = {
    units_mtd: mtd.length,
    revenue_mtd: money(mtd.reduce((s, x) => s + (Number(x.selling_price) || 0), 0)),
    leads_7d: leads7,
    leads_delta_pct: leadDelta,
  }
  const headline = items.length
    ? `${items.length} thing(s) need attention — ${items.filter(i => i.priority === 'high').length} high priority`
    : 'You’re all caught up — lot, leads, recon and tasks are current.'
  return { items, pulse, headline, hasWork: items.length > 0 }
}

function digestEmailHtml(dealerName, dg) {
  const arrow = dg.pulse.leads_delta_pct > 0 ? '▲' : dg.pulse.leads_delta_pct < 0 ? '▼' : '■'
  const rows = dg.items.length
    ? dg.items.map(i => `<tr><td style="padding:8px 12px;border-bottom:1px solid #eef2f7;font-size:15px;">${i.emoji} ${i.text}</td></tr>`).join('')
    : `<tr><td style="padding:14px 12px;font-size:15px;color:#16a34a;">✅ You’re all caught up.</td></tr>`
  return `<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 0;"><tr><td align="center">
  <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08);">
    <tr><td style="background:#1e3a8a;padding:18px 24px;color:#fff;">
      <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.8;">MarketSync · Morning Briefing</div>
      <div style="font-size:20px;font-weight:800;margin-top:2px;">${dealerName}</div>
      <div style="font-size:13px;opacity:.85;margin-top:2px;">${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</div>
    </td></tr>
    <tr><td style="padding:18px 24px 6px;font-size:15px;color:#0f172a;font-weight:600;">${dg.headline}</td></tr>
    <tr><td style="padding:0 12px;"><table width="100%" cellpadding="0" cellspacing="0">${rows}</table></td></tr>
    <tr><td style="padding:16px 24px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border-radius:8px;">
        <tr>
          <td style="padding:12px;text-align:center;border-right:1px solid #eef2f7;"><div style="font-size:22px;font-weight:800;color:#1e3a8a;">${dg.pulse.units_mtd}</div><div style="font-size:11px;color:#64748b;">units MTD</div></td>
          <td style="padding:12px;text-align:center;border-right:1px solid #eef2f7;"><div style="font-size:22px;font-weight:800;color:#1e3a8a;">${dg.pulse.revenue_mtd}</div><div style="font-size:11px;color:#64748b;">revenue MTD</div></td>
          <td style="padding:12px;text-align:center;"><div style="font-size:22px;font-weight:800;color:#1e3a8a;">${dg.pulse.leads_7d} <span style="font-size:13px;color:${dg.pulse.leads_delta_pct >= 0 ? '#16a34a' : '#dc2626'};">${arrow}${Math.abs(dg.pulse.leads_delta_pct)}%</span></div><div style="font-size:11px;color:#64748b;">leads last 7d</div></td>
        </tr>
      </table>
    </td></tr>
    <tr><td style="padding:6px 24px 22px;">
      <a href="${FRONTEND_URL}/dashboard.html" style="display:inline-block;background:#1e3a8a;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:10px 20px;border-radius:8px;">Open MarketSync →</a>
      <div style="font-size:11px;color:#94a3b8;margin-top:14px;">Ask MarketSync “what should I focus on today?” for the full breakdown. Turn this off in Automation settings.</div>
    </td></tr>
  </table></td></tr></table></body></html>`
}

async function runMorningDigest() {
  const { data: dealers } = await supabaseAdmin.from('dealerships').select('id, name, automation_settings')
  let pushed = 0, emailed = 0, skipped = 0
  for (const dl of (dealers || [])) {
    const s = dealerSettings(dl)
    if (!s.enabled || !s.digest_enabled) { skipped++; continue }
    const { data: mgrs } = await supabaseAdmin.from('profiles')
      .select('id, email, active').eq('dealership_id', dl.id).in('role', DEALER_LEVEL)
    const managers = (mgrs || []).filter(m => m.active !== false)
    if (!managers.length) { skipped++; continue }
    let dg
    try { dg = await buildDigest(dl.id) } catch { skipped++; continue }
    // In-app notification for each manager (their own targeted alert).
    for (const m of managers) {
      await createNotification({
        dealershipId: dl.id, type: 'daily_digest', targetUserId: m.id,
        title: 'Your morning briefing', body: dg.headline, linkPage: 'ai-insights',
      })
      pushed++
    }
    // Email (opt-in) — one per manager who has an address.
    if (s.digest_email) {
      const html = digestEmailHtml(dl.name || 'Your dealership', dg)
      const subject = `☀️ Morning briefing — ${dl.name || 'your store'} — ${dg.hasWork ? dg.headline : 'all caught up'}`
      for (const m of managers) {
        if (!m.email) continue
        try { await resend.emails.send({ from: EMAIL_FROM, to: m.email, subject, html }); emailed++ } catch (e) { /* skip a bad address */ }
      }
    }
  }
  return { pushed, emailed, skipped }
}

// ── Proactive WEEKLY briefing ───────────────────────────────────────────────
// A strategic recap: this week vs last (units, revenue, leads, appraisals) plus
// what's aging / unworked, wrapped in an AI-written GM narrative. The dealer can
// steer the narrative with a custom "focus" prompt in settings.
async function buildWeeklyBriefing(dealershipId, focus) {
  const now = Date.now()
  const d7 = new Date(now - 7 * 86400000).toISOString()
  const d14 = new Date(now - 14 * 86400000).toISOString()
  const nowIso = new Date().toISOString()
  const money = n => '$' + Math.round(Number(n) || 0).toLocaleString('en-US')

  const [deals, leads, apprs, inv, uncontacted, overdue] = await Promise.all([
    supabaseAdmin.from('deals').select('selling_price, sold_at, created_at, deal_status').eq('dealership_id', dealershipId).in('deal_status', ['sold', 'delivered']).gte('sold_at', d14).limit(2000),
    supabaseAdmin.from('leads').select('created_at, source').eq('dealership_id', dealershipId).gte('created_at', d14).limit(8000),
    supabaseAdmin.from('trade_appraisals').select('created_at').eq('dealership_id', dealershipId).gte('created_at', d14).limit(2000),
    supabaseAdmin.from('inventory').select('created_at, lot_date').eq('dealership_id', dealershipId).eq('status', 'available').limit(3000),
    supabaseAdmin.from('contacts').select('id', { count: 'exact', head: true }).eq('dealership_id', dealershipId).eq('status', 'uncontacted'),
    supabaseAdmin.from('crm_tasks').select('id', { count: 'exact', head: true }).eq('dealership_id', dealershipId).eq('done', false).lt('due_at', nowIso),
  ])
  const inWk = (arr, key) => (arr || []).filter(x => (x[key] || x.created_at) >= d7)
  const inPrev = (arr, key) => (arr || []).filter(x => { const t = x[key] || x.created_at; return t && t >= d14 && t < d7 })
  const soldWk = inWk(deals.data, 'sold_at'), soldPrev = inPrev(deals.data, 'sold_at')
  const leadsWk = inWk(leads.data), leadsPrev = inPrev(leads.data)
  const apprWk = inWk(apprs.data), apprPrev = inPrev(apprs.data)
  const revWk = soldWk.reduce((s, x) => s + (Number(x.selling_price) || 0), 0)
  const revPrev = soldPrev.reduce((s, x) => s + (Number(x.selling_price) || 0), 0)
  const age = v => { const ref = v.lot_date || v.created_at; return ref ? Math.floor((now - new Date(ref)) / 86400000) : 0 }
  const aged60 = (inv.data || []).filter(v => age(v) >= 60).length
  const pct = (a, b) => b ? Math.round(((a - b) / b) * 100) : (a ? 100 : 0)
  // Top lead sources this week.
  const srcCount = {}; for (const l of leadsWk) { const k = l.source || 'Unknown'; srcCount[k] = (srcCount[k] || 0) + 1 }
  const topSources = Object.entries(srcCount).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([s, n]) => `${s} (${n})`)

  const stats = {
    units: { wk: soldWk.length, prev: soldPrev.length, delta: pct(soldWk.length, soldPrev.length) },
    revenue: { wk: money(revWk), prev: money(revPrev), delta: pct(revWk, revPrev) },
    leads: { wk: leadsWk.length, prev: leadsPrev.length, delta: pct(leadsWk.length, leadsPrev.length) },
    appraisals: { wk: apprWk.length, prev: apprPrev.length, delta: pct(apprWk.length, apprPrev.length) },
    aged_60_plus: aged60, uncontacted: uncontacted.count || 0, overdue_tasks: overdue.count || 0,
    top_sources: topSources,
  }

  // AI narrative (gated by AI Boost + budget). Falls back to a templated recap.
  let narrative = null
  const { data: dealer } = await supabaseAdmin.from('dealerships').select('name, ai_boost_active, ai_internal_style').eq('id', dealershipId).maybeSingle()
  const isOwnerless = false
  if (process.env.ANTHROPIC_API_KEY && (dealer?.ai_boost_active) && await aiAllowed(dealershipId, isOwnerless)) {
    const facts = `Units sold: ${stats.units.wk} (prev ${stats.units.prev}, ${stats.units.delta >= 0 ? '+' : ''}${stats.units.delta}%). Revenue: ${stats.revenue.wk} (${stats.revenue.delta >= 0 ? '+' : ''}${stats.revenue.delta}%). New leads: ${stats.leads.wk} (${stats.leads.delta >= 0 ? '+' : ''}${stats.leads.delta}%). Appraisals: ${stats.appraisals.wk}. Units 60+ days: ${stats.aged_60_plus}. Uncontacted leads: ${stats.uncontacted}. Overdue tasks: ${stats.overdue_tasks}. Top lead sources: ${topSources.join(', ') || 'n/a'}.`
    const styleLine = dealer?.ai_internal_style ? ` Voice: ${dealer.ai_internal_style}.` : ''
    const focusLine = focus ? ` The GM specifically wants this to focus on: ${focus}.` : ''
    const prompt = `You are the GM's analyst writing this dealership's WEEKLY briefing. Write 3–4 short sentences: how the week went vs last week (lead with the trend), the single biggest win, and the top 1–2 things to fix or push next week. Be direct and specific with the numbers. No markdown, no headings, no greeting.${focusLine}${styleLine}\n\nThis week's data: ${facts}`
    try {
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
      const msg = await Promise.race([
        anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 300, messages: [{ role: 'user', content: prompt }] }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('ai timeout')), 20000)),
      ])
      narrative = (msg?.content?.[0]?.text || '').trim() || null
      if (narrative) recordUsage(dealershipId, { ai: 1 })
    } catch { /* fall through to templated */ }
  }
  if (!narrative) {
    const dir = stats.units.delta >= 0 ? 'up' : 'down'
    narrative = `${stats.units.wk} units and ${stats.revenue.wk} this week — sales ${dir} ${Math.abs(stats.units.delta)}% vs last week on ${stats.leads.wk} new leads. ${stats.uncontacted} uncontacted lead(s) and ${stats.overdue_tasks} overdue task(s) to clear; ${stats.aged_60_plus} unit(s) are 60+ days old and need a pricing decision.`
  }
  const headline = `${stats.units.wk} sold · ${stats.revenue.wk} · ${stats.leads.wk} leads this week`
  return { stats, narrative, headline, dealer_name: dealer?.name || 'Your dealership' }
}

function weeklyEmailHtml(dealerName, wk) {
  const chip = (label, v, delta) => {
    const col = delta > 0 ? '#16a34a' : delta < 0 ? '#dc2626' : '#64748b'
    const arrow = delta > 0 ? '▲' : delta < 0 ? '▼' : '■'
    return `<td style="padding:12px;text-align:center;border-right:1px solid #eef2f7;"><div style="font-size:22px;font-weight:800;color:#4338ca;">${v}</div><div style="font-size:11px;color:#64748b;">${label} <span style="color:${col};">${arrow}${Math.abs(delta)}%</span></div></td>`
  }
  return `<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 0;"><tr><td align="center">
  <table width="580" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08);">
    <tr><td style="background:#4338ca;padding:18px 24px;color:#fff;">
      <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.85;">MarketSync · Weekly Briefing</div>
      <div style="font-size:20px;font-weight:800;margin-top:2px;">${dealerName}</div>
      <div style="font-size:13px;opacity:.85;margin-top:2px;">Week ending ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}</div>
    </td></tr>
    <tr><td style="padding:18px 24px 8px;font-size:15px;color:#0f172a;line-height:1.55;">${wk.narrative}</td></tr>
    <tr><td style="padding:8px 24px 16px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border-radius:8px;"><tr>
        ${chip('units', wk.stats.units.wk, wk.stats.units.delta)}
        ${chip('revenue', wk.stats.revenue.wk, wk.stats.revenue.delta)}
        ${chip('leads', wk.stats.leads.wk, wk.stats.leads.delta)}
        <td style="padding:12px;text-align:center;"><div style="font-size:22px;font-weight:800;color:#4338ca;">${wk.stats.appraisals.wk}</div><div style="font-size:11px;color:#64748b;">appraisals</div></td>
      </tr></table>
    </td></tr>
    <tr><td style="padding:0 24px 8px;font-size:13px;color:#475569;">
      ${wk.stats.uncontacted} uncontacted · ${wk.stats.overdue_tasks} overdue tasks · ${wk.stats.aged_60_plus} units 60+ days${wk.stats.top_sources.length ? ` · top sources: ${wk.stats.top_sources.join(', ')}` : ''}
    </td></tr>
    <tr><td style="padding:10px 24px 22px;">
      <a href="${FRONTEND_URL}/dashboard.html" style="display:inline-block;background:#4338ca;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:10px 20px;border-radius:8px;">Open MarketSync →</a>
      <div style="font-size:11px;color:#94a3b8;margin-top:14px;">Manage the weekly briefing (day, email, focus) in Automation settings.</div>
    </td></tr>
  </table></td></tr></table></body></html>`
}

async function runWeeklyBriefing(force = false) {
  const today = new Date().getDay()   // 0=Sun … 6=Sat (server tz)
  const { data: dealers } = await supabaseAdmin.from('dealerships').select('id, name, automation_settings')
  let pushed = 0, emailed = 0, skipped = 0
  for (const dl of (dealers || [])) {
    const s = dealerSettings(dl)
    if (!s.enabled || !s.weekly_enabled) { skipped++; continue }
    if (!force && s.weekly_day !== today) { skipped++; continue }
    const { data: mgrs } = await supabaseAdmin.from('profiles').select('id, email, active').eq('dealership_id', dl.id).in('role', DEALER_LEVEL)
    const managers = (mgrs || []).filter(m => m.active !== false)
    if (!managers.length) { skipped++; continue }
    let wk
    try { wk = await buildWeeklyBriefing(dl.id, s.weekly_focus) } catch { skipped++; continue }
    for (const m of managers) {
      await createNotification({ dealershipId: dl.id, type: 'weekly_briefing', targetUserId: m.id, title: 'Your weekly briefing', body: wk.headline, linkPage: 'ai-insights' })
      pushed++
    }
    if (s.weekly_email) {
      const html = weeklyEmailHtml(dl.name || 'Your dealership', wk)
      const subject = `📊 Weekly briefing — ${dl.name || 'your store'} — ${wk.headline}`
      for (const m of managers) { if (!m.email) continue; try { await resend.emails.send({ from: EMAIL_FROM, to: m.email, subject, html }); emailed++ } catch {} }
    }
  }
  return { pushed, emailed, skipped, weekday: today }
}

// ─────────────────────────────────────────────────────────────────────────────
export function registerAutomation(app) {
  const cronOk = (req) => (req.headers['x-cron-secret'] || '').trim() === (process.env.CRON_SECRET || '').trim() && !!process.env.CRON_SECRET

  // ── Safe diagnostic: is the cron secret configured + does a given header match?
  // Reveals only booleans (never the secret). Open it in a browser (no header) to
  // check whether the SERVER has CRON_SECRET set; add the header to check a match.
  app.get('/cron/selftest', (req, res) => {
    const provided = (req.headers['x-cron-secret'] || '').trim()
    const server = (process.env.CRON_SECRET || '').trim()
    res.json({
      server_secret_configured: !!server,
      provided_header_present: !!provided,
      matches: !!server && provided === server,
      hint: !server ? 'Set CRON_SECRET in the Render service Environment tab.'
        : !provided ? 'Server secret is set. Send x-cron-secret to test a match (GitHub secret CRON_SECRET must equal it).'
        : (provided === server ? 'All good — crons will authenticate.' : 'Header present but does not match the server secret. Make the GitHub secret equal the Render value.'),
    })
  })

  // ── Background worker cron endpoints ───────────────────────────────────────
  app.post('/cron/automation-run', async (req, res) => {
    if (!cronOk(req)) return res.status(401).json({ error: 'unauthorized' })
    try { const pre = await runPrecheck(); const run = await runDue(); res.json({ ok: true, precheck: pre, dispatch: run }) }
    catch (e) { res.status(500).json({ error: e.message }) }
  })
  app.post('/cron/automation-daily', async (req, res) => {
    if (!cronOk(req)) return res.status(401).json({ error: 'unauthorized' })
    try { res.json({ ok: true, ...(await runDaily()) }) } catch (e) { res.status(500).json({ error: e.message }) }
  })
  // Proactive morning briefing — schedule this once each morning (e.g. 7am local).
  app.post('/cron/morning-digest', async (req, res) => {
    if (!cronOk(req)) return res.status(401).json({ error: 'unauthorized' })
    try { res.json({ ok: true, ...(await runMorningDigest()) }) } catch (e) { res.status(500).json({ error: e.message }) }
  })
  // Manager self-serve: send myself today's briefing right now (for the "preview" button).
  app.post('/automation/digest/preview', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    if (!isDealerLevel(req)) return res.status(403).json({ error: 'Manager access required' })
    try {
      const dg = await buildDigest(req.dealershipId)
      const email = req.profile?.email || req.user?.email
      if (email) {
        const { data: dl } = await supabaseAdmin.from('dealerships').select('name').eq('id', req.dealershipId).maybeSingle()
        await resend.emails.send({ from: EMAIL_FROM, to: email, subject: `☀️ Morning briefing (preview) — ${dl?.name || 'your store'}`, html: digestEmailHtml(dl?.name || 'Your dealership', dg) })
      }
      res.json({ ok: true, headline: dg.headline, items: dg.items, pulse: dg.pulse, emailed_to: email || null })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // Proactive weekly briefing — schedule this daily; it only fires for dealers whose
  // configured weekly_day matches today (so one cron covers everyone's chosen day).
  app.post('/cron/weekly-briefing', async (req, res) => {
    if (!cronOk(req)) return res.status(401).json({ error: 'unauthorized' })
    try { res.json({ ok: true, ...(await runWeeklyBriefing(false)) }) } catch (e) { res.status(500).json({ error: e.message }) }
  })
  // Manager self-serve: build + email myself this week's briefing right now.
  app.post('/automation/weekly/preview', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    if (!isDealerLevel(req)) return res.status(403).json({ error: 'Manager access required' })
    try {
      const { data: dl } = await supabaseAdmin.from('dealerships').select('name, automation_settings').eq('id', req.dealershipId).maybeSingle()
      const wk = await buildWeeklyBriefing(req.dealershipId, dealerSettings(dl).weekly_focus)
      const email = req.profile?.email || req.user?.email
      if (email) {
        await resend.emails.send({ from: EMAIL_FROM, to: email, subject: `📊 Weekly briefing (preview) — ${dl?.name || 'your store'}`, html: weeklyEmailHtml(dl?.name || 'Your dealership', wk) })
      }
      res.json({ ok: true, headline: wk.headline, narrative: wk.narrative, stats: wk.stats, emailed_to: email || null })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // ── Inbound webhook (SMS/email reply) → drop-out freeze + STOP handling ─────
  app.post('/automation/inbound', async (req, res) => {
    const b = req.body || {}
    const from = b.from || b.From || ''
    const channel = (b.channel || (b.From ? 'sms' : 'email')).toLowerCase()
    const text = String(b.body || b.Body || '').trim()
    try {
      const dealershipId = b.dealership_id || null
      let q = supabaseAdmin.from('contacts').select('id, dealership_id, tags')
      if (channel === 'sms') q = q.eq('phone', from); else q = q.ilike('email', String(from).toLowerCase())
      if (dealershipId) q = q.eq('dealership_id', dealershipId)
      const { data: contact } = await q.limit(1).maybeSingle()
      if (!contact) return res.json({ ok: true, matched: false })
      if (/^\s*(stop|unsubscribe|quit|cancel|end)\b/i.test(text)) {
        await supabaseAdmin.from('contacts').update({ opt_out: true, consent_sms: false, automation_paused: true }).eq('id', contact.id)
        await freezeSequences(contact.id, 'opted_out')
        return res.json({ ok: true, opted_out: true })
      }
      await freezeSequences(contact.id, 'customer_replied')
      res.json({ ok: true, frozen: true })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // ── Campaign management (manager) ──────────────────────────────────────────
  app.get('/automation/campaigns', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    if (!isDealerLevel(req)) return res.status(403).json({ error: 'Manager access required', can_manage: false })
    await ensureCampaigns(req.dealershipId)
    const [{ data: campaigns }, { data: dealer }] = await Promise.all([
      supabaseAdmin.from('automated_campaigns').select('*').eq('dealership_id', req.dealershipId).order('sort'),
      supabaseAdmin.from('dealerships').select('automation_settings, province, country').eq('id', req.dealershipId).maybeSingle(),
    ])
    res.json({ campaigns: campaigns || [], settings: dealerSettings(dealer), region: { province: dealer?.province || null, country: dealer?.country || null }, can_manage: true })
  })
  app.put('/automation/campaigns/:id', requireAuth, async (req, res) => {
    if (!isDealerLevel(req)) return res.status(403).json({ error: 'Manager access required' })
    const b = req.body || {}, patch = { updated_at: nowIso() }
    if (b.name !== undefined) patch.name = String(b.name).slice(0, 120)
    if (b.subject_template !== undefined) patch.subject_template = String(b.subject_template || '').slice(0, 300) || null
    if (b.message_body_template !== undefined) patch.message_body_template = String(b.message_body_template || '').slice(0, 4000)
    if (b.is_active !== undefined) patch.is_active = !!b.is_active
    if (b.delay_minutes !== undefined) patch.delay_minutes = Math.max(0, parseInt(b.delay_minutes) || 0)
    if (b.send_at_hour !== undefined) patch.send_at_hour = b.send_at_hour === null ? null : Math.max(0, Math.min(23, parseInt(b.send_at_hour) || 0))
    if (b.sender_identity !== undefined && ['house', 'rep', 'dynamic_smart_switch'].includes(b.sender_identity)) patch.sender_identity = b.sender_identity
    const { data, error } = await supabaseAdmin.from('automated_campaigns').update(patch).eq('id', req.params.id).eq('dealership_id', req.dealershipId).select('*').maybeSingle()
    if (error) return res.status(500).json({ error: error.message })
    if (!data) return res.status(404).json({ error: 'Campaign not found' })
    res.json({ ok: true, campaign: data })
  })
  // Create a new campaign — used by the "Add more" template library on the
  // Lead / Delivery / Holiday automation pages.
  app.post('/automation/campaigns', requireAuth, async (req, res) => {
    if (!isDealerLevel(req)) return res.status(403).json({ error: 'Manager access required' })
    const b = req.body || {}
    const TRIGGERS = ['internet_lead', 'appointment_booked', 'show_no_sale', 'delivered', 'birthday', 'holiday']
    const trigger = TRIGGERS.includes(b.trigger_event) ? b.trigger_event : 'internet_lead'
    const channel = ['sms', 'email', 'task'].includes(b.channel) ? b.channel : 'email'
    const category = ['pipeline', 'retention', 'reviews', 'referrals', 'equity', 'calendar', 'tasks', 'custom'].includes(b.category) ? b.category : 'custom'
    if (!b.message_body_template) return res.status(400).json({ error: 'message_body_template required' })
    // Highest current sort + 10, so new ones land at the bottom of their group.
    const { data: maxRow } = await supabaseAdmin.from('automated_campaigns').select('sort').eq('dealership_id', req.dealershipId).order('sort', { ascending: false }).limit(1).maybeSingle()
    const row = {
      dealership_id: req.dealershipId,
      key: 'custom_' + Math.random().toString(36).slice(2, 10),
      name: String(b.name || 'New automation').slice(0, 120),
      category, trigger_event: trigger, channel,
      subject_template: channel === 'email' ? (String(b.subject_template || '').slice(0, 300) || null) : null,
      message_body_template: String(b.message_body_template).slice(0, 4000),
      delay_minutes: Math.max(0, parseInt(b.delay_minutes) || 0),
      send_at_hour: b.send_at_hour == null ? null : Math.max(0, Math.min(23, parseInt(b.send_at_hour) || 0)),
      sender_identity: ['house', 'rep', 'dynamic_smart_switch'].includes(b.sender_identity) ? b.sender_identity : (channel === 'email' ? 'house' : 'rep'),
      is_active: b.is_active === false ? false : true,
      sort: ((maxRow?.sort ?? 900) + 10),
    }
    const { data, error } = await supabaseAdmin.from('automated_campaigns').insert(row).select('*').single()
    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true, campaign: data })
  })
  // Delete a (custom) campaign.
  app.delete('/automation/campaigns/:id', requireAuth, async (req, res) => {
    if (!isDealerLevel(req)) return res.status(403).json({ error: 'Manager access required' })
    const { error } = await supabaseAdmin.from('automated_campaigns').delete().eq('id', req.params.id).eq('dealership_id', req.dealershipId)
    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true })
  })
  app.post('/automation/campaigns/reset', requireAuth, async (req, res) => {
    if (!isDealerLevel(req)) return res.status(403).json({ error: 'Manager access required' })
    await supabaseAdmin.from('automated_campaigns').delete().eq('dealership_id', req.dealershipId)
    await ensureCampaigns(req.dealershipId)
    const { data } = await supabaseAdmin.from('automated_campaigns').select('*').eq('dealership_id', req.dealershipId).order('sort')
    res.json({ ok: true, campaigns: data || [] })
  })

  // ── Settings (review URL, referral bonus, business hours, holidays…) ───────
  app.put('/automation/settings', requireAuth, async (req, res) => {
    if (!isDealerLevel(req)) return res.status(403).json({ error: 'Manager access required' })
    const b = req.body || {}
    const { data: cur } = await supabaseAdmin.from('dealerships').select('automation_settings').eq('id', req.dealershipId).maybeSingle()
    const s = { ...(cur?.automation_settings || {}) }
    for (const k of ['review_url', 'referral_bonus', 'service_url', 'house_sms', 'house_email', 'timezone']) if (b[k] !== undefined) s[k] = b[k] === '' ? null : String(b[k]).slice(0, 300)
    // Professional email setup: from-name/address, reply-to, who we send as
    // (house = dealership general, rep = the salesperson, both = rep with the
    // dealership on reply-to), and whether to log each send to the CRM timeline.
    if (b.email && typeof b.email === 'object') {
      const e = { ...(s.email || {}) }
      const str = (v) => v == null || v === '' ? null : String(v).slice(0, 200)
      if (b.email.from_name !== undefined) e.from_name = str(b.email.from_name)
      if (b.email.from !== undefined) e.from = str(b.email.from)
      if (b.email.reply_to !== undefined) e.reply_to = str(b.email.reply_to)
      if (b.email.sender_mode !== undefined) e.sender_mode = ['house', 'rep', 'both'].includes(b.email.sender_mode) ? b.email.sender_mode : 'house'
      if (b.email.track_to_tasks !== undefined) e.track_to_tasks = !!b.email.track_to_tasks
      s.email = e
    }
    if (b.business_start !== undefined) s.business_start = Math.max(0, Math.min(23, parseInt(b.business_start) || 0))
    if (b.business_end !== undefined) s.business_end = Math.max(0, Math.min(24, parseInt(b.business_end) || 19))
    if (b.enabled !== undefined) s.enabled = !!b.enabled
    if (b.digest_enabled !== undefined) s.digest_enabled = !!b.digest_enabled
    if (b.digest_email !== undefined) s.digest_email = !!b.digest_email
    if (b.weekly_enabled !== undefined) s.weekly_enabled = !!b.weekly_enabled
    if (b.weekly_email !== undefined) s.weekly_email = !!b.weekly_email
    if (b.weekly_day !== undefined) { const n = parseInt(b.weekly_day); if (Number.isInteger(n) && n >= 0 && n <= 6) s.weekly_day = n }
    if (b.weekly_focus !== undefined) s.weekly_focus = (b.weekly_focus || '').toString().trim().slice(0, 600) || null
    if (Array.isArray(b.holidays)) s.holidays = b.holidays.slice(0, 60).map(h => ({
      name: String(h.name || '').slice(0, 60), date: String(h.date || '').slice(0, 5),
      rule: /^(nth|last|monbefore|easter):/.test(String(h.rule || '')) ? String(h.rule).slice(0, 40) : null,
      country: (h.country === 'CA' || h.country === 'US') ? h.country : 'BOTH',
      enabled: h.enabled !== false,
      subject: h.subject ? String(h.subject).slice(0, 200) : null,
      message: h.message ? String(h.message).slice(0, 3000) : null,
    })).filter(h => h.name && (/^\d{2}-\d{2}$/.test(h.date) || h.rule))
    await supabaseAdmin.from('dealerships').update({ automation_settings: s }).eq('id', req.dealershipId)
    res.json({ ok: true, settings: dealerSettings({ automation_settings: s }) })
  })

  // ── Manual event fire (delivered / show_no_sale / appointment / lead) ──────
  app.post('/automation/event', requireAuth, async (req, res) => {
    if (!isDealerLevel(req)) return res.status(403).json({ error: 'Manager access required' })
    const b = req.body || {}
    const trigger = String(b.trigger || '')
    if (!['internet_lead', 'appointment_booked', 'show_no_sale', 'delivered'].includes(trigger)) return res.status(400).json({ error: 'Bad trigger' })
    if (!b.contact_id) return res.status(400).json({ error: 'contact_id required' })
    const { data: c } = await supabaseAdmin.from('contacts').select('id, assigned_rep, interest_inventory_id').eq('id', b.contact_id).eq('dealership_id', req.dealershipId).maybeSingle()
    if (!c) return res.status(404).json({ error: 'Contact not found' })
    const vehicleId = b.vehicle_id || c.interest_inventory_id || null
    if (trigger === 'delivered') await markDelivered(req.dealershipId, c.id, vehicleId, c.assigned_rep, b.delivery_date)
    else await enqueueForTrigger(req.dealershipId, trigger, { contactId: c.id, vehicleId, repId: c.assigned_rep })
    res.json({ ok: true })
  })

  // ── Upcoming queue (for a contact or the whole store) ──────────────────────
  app.get('/automation/queue', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    let q = supabaseAdmin.from('scheduled_messages').select('id, contact_id, campaign_id, channel, sender_identity, scheduled_at, status, cancel_reason, interval_marker').eq('dealership_id', req.dealershipId)
    if (req.query.contact_id) q = q.eq('contact_id', req.query.contact_id)
    if (req.query.status) q = q.eq('status', req.query.status)
    const { data } = await q.order('scheduled_at').limit(200)
    res.json({ queue: data || [] })
  })

  // ── AI copy generation (context-aware) ─────────────────────────────────────
  app.post('/automation/ai-copy', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    const b = req.body || {}
    const instruction = String(b.instruction || '').slice(0, 400)
    const ctx = b.context || {}
    const { data: dealer } = await supabaseAdmin.from('dealerships').select('name, ai_boost_active').eq('id', req.dealershipId).maybeSingle()
    const isOwner = (req.user?.email || '').toLowerCase() === (process.env.OWNER_EMAIL || 'massiejay@gmail.com')
    if (!isOwner && !dealer?.ai_boost_active) return res.status(403).json({ error: 'AI Boost not active' })
    if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'AI features not configured' })
    const channel = ctx.channel === 'email' ? 'email' : 'sms'
    const identity = ctx.sender_identity || 'rep'
    // Strict guardrails wrapper so the model returns clean, on-brand, compliant copy.
    const sys = `You write high-converting, human-sounding automotive CRM follow-up copy for ${dealer?.name || 'a dealership'}.
Rules:
- Channel: ${channel}. ${channel === 'sms' ? 'Keep it under 320 characters, casual, like a real person texting. No links unless a {{token}} provides one. No emoji unless explicitly asked.' : 'A short, warm email body. No subject line, no signature block.'}
- Sender identity: ${identity}. ${identity === 'rep' ? 'First-person from the salesperson — personal and plain, never corporate.' : identity === 'house' ? 'Warm but professional, from the dealership.' : 'Professional but friendly.'}
- Campaign type: ${ctx.campaign_type || 'follow-up'}${ctx.interval_marker ? `, interval marker: month ${ctx.interval_marker}` : ''}.
- Use ONLY these variables where natural, with a fallback after a pipe: {{customer.first_name|there}}, {{vehicle.ymm}}, {{vehicle.model}}, {{rep.first_name}}, {{dealership.name}}, {{review_url}}, {{referral_bonus}}, {{service_url}}. Never invent other tokens.
- ${ctx.strict_guardrails === false ? '' : 'Do NOT include opt-out language (the system appends it). '}No fake urgency, no ALL CAPS, no spammy claims.
Return ONLY the message text — no preamble, no quotes, no markdown.`
    try {
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
      const msg = await Promise.race([
        anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 500, temperature: 1, system: sys, messages: [{ role: 'user', content: instruction || 'Write the message.' }] }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('ai timeout')), 25000)),
      ])
      const text = (msg?.content?.[0]?.text || '').trim().replace(/^["']|["']$/g, '')
      if (!text) throw new Error('No copy generated')
      res.json({ ok: true, text })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // ── Live template preview (renders against a sample or real contact) ───────
  app.post('/automation/preview', requireAuth, async (req, res) => {
    const b = req.body || {}
    const { data: dealer } = await supabaseAdmin.from('dealerships').select('id, name, site_slug, branding, automation_settings').eq('id', req.dealershipId).maybeSingle()
    const s = dealerSettings(dealer)
    let contact = { first_name: 'Alex', full_name: 'Alex Morgan', last_name: 'Morgan' }, vehicle = { year: 2025, make: 'Chevrolet', model: 'Silverado 1500', trim: 'LT' }, rep = { display_name: 'Jordan Lee' }
    if (b.contact_id) {
      const { data: c } = await supabaseAdmin.from('contacts').select('*').eq('id', b.contact_id).eq('dealership_id', req.dealershipId).maybeSingle()
      if (c) { contact = c; if (c.assigned_rep) rep = (await supabaseAdmin.from('profiles').select('full_name, display_name').eq('id', c.assigned_rep).maybeSingle()).data || rep; if (c.interest_inventory_id) vehicle = (await supabaseAdmin.from('inventory').select('year, make, model, trim').eq('id', c.interest_inventory_id).maybeSingle()).data || vehicle }
    }
    const vars = buildVars(contact, vehicle, rep, dealer, s)
    res.json({ ok: true, subject: b.subject_template ? renderTemplate(b.subject_template, vars) : null, body: renderTemplate(b.message_body_template || '', vars) })
  })
}
