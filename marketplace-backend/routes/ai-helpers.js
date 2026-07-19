/**
 * Shared helpers for the AI routes (extracted from ai.js to keep files navigable).
 * Cross-cutting utilities: report builder, assistant tools, price math, digest.
 */
import Anthropic from '@anthropic-ai/sdk'
import { supabaseAdmin, resend, EMAIL_FROM, FRONTEND_URL, browserFetch } from '../shared.js'
import { requireAuth } from '../middleware.js'
import { marketcheckMarket, marketcheckListings, marketcheckEnabled, marketcheckCompetitorStats, marketcheckPing, marketcheckDecodeVin, marketcheckPredictPrice, marketcheckMarketStats } from '../marketcheck.js'
import { getMarketData, getSoldData, recordUsage, aiAllowed, getUsage, assistantDailyAllowed, recordAssistantChat, ASSISTANT_DAILY_LIMIT, marketcheckAllowed, recordMarketcheckCall } from '../usage.js'
import { findOrCreateContact } from './crm.js'
import { buildEquityRadar } from './equity.js'
import { buildMarketingRoi } from './marketing.js'
import { createNotification, createNotifications } from '../notifications.js'
import { runPhotoVision, scoreVehiclePhotos } from '../sync/photoVision.js'
import { fetchOemWindowStickerPdf } from '../utils/oemWindowSticker.js'
import { lookupPlate, plateLookupConfigured } from '../providers/plateLookup.js'

const OWNER_EMAIL = (process.env.OWNER_EMAIL || 'massiejay@gmail.com').toLowerCase()

// Best-effort: pull the factory (OEM) window sticker for an acquired unit's VIN and
// attach it, so a freshly-taken trade carries real factory documentation before the
// lot shoots photos (#18). Fire-and-forget — never blocks or fails the acquisition.
async function attachOemStickerToInventory(dealershipId, inventoryId, vehicle) {
  try {
    if (!vehicle?.vin) return
    const oem = await fetchOemWindowStickerPdf({ vin: vehicle.vin, make: vehicle.make || null }).catch(() => null)
    if (!oem?.buffer) return
    const path = `${dealershipId}/appraisal/${vehicle.vin}-window-sticker-oem.pdf`
    const { error } = await supabaseAdmin.storage.from('vehicle-pdfs').upload(path, oem.buffer, { contentType: 'application/pdf', upsert: true })
    if (error) return
    const { data: { publicUrl } } = supabaseAdmin.storage.from('vehicle-pdfs').getPublicUrl(path)
    if (publicUrl) await supabaseAdmin.from('inventory').update({ window_sticker_oem_url: publicUrl }).eq('id', inventoryId).eq('dealership_id', dealershipId)
  } catch (e) { console.warn('[acquire] OEM sticker attach failed:', e.message) }
}

// Google-Translate language codes → names, so AI-written listing copy can be
// requested in the rep's chosen language. Unknown codes pass through as-is.
const LANG_NAME = {
  en: 'English', fr: 'French', es: 'Spanish', de: 'German', it: 'Italian',
  pt: 'Portuguese', nl: 'Dutch', pl: 'Polish', ru: 'Russian', uk: 'Ukrainian',
  ar: 'Arabic', hi: 'Hindi', pa: 'Punjabi', ur: 'Urdu', fa: 'Persian',
  zh: 'Chinese', 'zh-cn': 'Chinese (Simplified)', 'zh-tw': 'Chinese (Traditional)',
  ja: 'Japanese', ko: 'Korean', vi: 'Vietnamese', tl: 'Tagalog', th: 'Thai',
  tr: 'Turkish', el: 'Greek', he: 'Hebrew', ro: 'Romanian', so: 'Somali',
}
const langName = code => LANG_NAME[String(code || '').toLowerCase()] || code || ''

// Product knowledge the in-dashboard assistant answers "how does MarketSync
// work / what do I get / how much" questions from. Kept here (not a DB) so it's
// easy to edit in one place — update it whenever features or pricing change.
const PRODUCT_KB = `ABOUT MARKETSYNC
MarketSync is a dealership tool that syncs your used-car inventory, posts and manages listings (incl. Facebook Marketplace), tracks leads and a sales pipeline, gamifies the sales team, and layers AI + live market data on top. There's a Chrome extension for posting/lead capture.

CORE (included) FEATURES
- Inventory: auto-sync from your website/feed; per-vehicle VIN decode, recall checks, window stickers & brochures (PDF).
- Pipeline & Leads: capture Marketplace leads, sales pipeline stages (Posted → Appointment Set → Claimed Sale → Needs Relisting), appointments with a month calendar + reminders.
- Insights: listing/sales trends and per-rep activity charts.
- Leaderboard & Sales Team: rep points/tiers, per-rep insight modal.
- Profile & Settings: account, team, billing, security.

ADD-ONS (paid, per dealership / month)
- AI Boost — about $129/mo: one-click AI listing copy, AI reply drafts for leads, AI Vision photo scoring + best-hero pick, AI-written blurbs on window stickers/brochures, AI lot-analysis summary, the daily "Today's Briefing", and this assistant.
- Inventory Intelligence — about $299/mo: live market pricing & price flags (over/under market), competitor monitoring, lot analysis (turn rate, health scores, hot/cold movers, duplicate VINs, aged units), repricing rules, stocking recommendations, Trade Appraisal (live market value + suggested cash/trade offer), market reports, and this assistant.
The account owner has every feature. Prices are approximate — tell users to check the upgrade screen (any locked feature opens it) or Profile & Settings › billing for exact, current pricing.

WHERE THINGS LIVE (nav)
Insights · Inventory · Pipeline · Appraisal (Inventory Intelligence) · Leaderboard · Sales Team · Inv. Intelligence (paid) · Profile & Settings. VIN decode, recalls, stickers & brochures are on each vehicle under Inventory.

COMMON HOW-TOs
- Sync inventory: Inventory page → Sync button.
- Decode a VIN / see recalls: open a vehicle in Inventory (or use Decode VIN on the Appraisal page).
- Appraise a trade: Appraisal page → enter VIN/details → Appraise.
- Draft a lead reply: open the lead in Pipeline → AI reply.
- See what's aging / priced off market / restock: Inv. Intelligence page.`

// Live-data tools the assistant can call on demand. Each one is a paid MarketCheck
// call, so it runs through the same allow/record gate (monthly quota + daily cap +
// global budget) as every other lookup. Owner is exempt from the per-dealer caps.
const ASSISTANT_TOOLS = [
  {
    name: 'decode_vin',
    description: 'Decode a 17-character VIN into a full spec sheet (year, make, model, trim, engine, drivetrain, options, fuel economy, MSRP). Use when the user gives a VIN and wants specs.',
    input_schema: { type: 'object', properties: { vin: { type: 'string', description: '17-character VIN' } }, required: ['vin'] },
  },
  {
    name: 'predict_price',
    description: 'Model-comparable predicted retail price and confidence band for a specific VIN. Use for "what is a fair price / what is this worth" when a VIN is available.',
    input_schema: { type: 'object', properties: { vin: { type: 'string' }, miles: { type: 'number', description: 'Odometer reading, optional' } }, required: ['vin'] },
  },
  {
    name: 'market_snapshot',
    description: 'Live market stats — active listing count, median price, and average days-on-market — for a make/model (optionally a year/trim). Use for "how is X selling / days on market / demand / is it hot or stale".',
    input_schema: { type: 'object', properties: { make: { type: 'string' }, model: { type: 'string' }, year: { type: 'number' }, trim: { type: 'string' } }, required: ['make', 'model'] },
  },
  {
    name: 'dealership_report',
    description: "Pull THIS dealership's own live operating data. Use for anything about the store's own numbers or people: sales & units this month, gross, F&I, commissions, which salesperson is ahead or needs coaching, lead volume/sources/conversion, unworked leads, aging inventory, reconditioning/cleanup status, overdue tasks, today's appointments, who to call today, and recent trade appraisals. Power topics: 'trends' compares this period to the prior one (sales this month vs last, leads last 30d vs the 30 before, which lead sources rose or fell — use for 'are we up or down / why did leads drop'); 'priorities' returns a ranked what-to-do-today list; 'pricing' returns per-unit price/aging actions — which specific cars to discount, wholesale, or send to auction (days-on-lot, off-market flags, missing prices), and for the top reprice candidates a LIVE market median + concrete reprice target and how far each unit sits above/below market (use for 'which cars should I discount/wholesale today' and 'what should I reprice this to'); 'equity' returns the who-to-call upgrade list — delivered customers now in a positive-equity or lease-maturing position, ranked by equity (use for 'who can I put in a new car / who to call for an upgrade / lease pull-ahead'); 'marketing_roi' returns which advertising channel paid off — spend vs leads, sales, cost-per-lead, cost-per-sale, revenue and ROI per channel (use for 'which campaign made money / where should I spend my ad budget / what's my cost per lead'). Prefer this over guessing. Use 'overview' for a general 'how are we doing'.",
    input_schema: { type: 'object', properties: { topic: { type: 'string', enum: ['overview', 'sales', 'commissions', 'reps', 'leads', 'inventory', 'recon', 'tasks', 'appraisals', 'trends', 'priorities', 'pricing', 'equity'], description: 'Which slice of the dealership to report on.' } }, required: ['topic'] },
  },
]

// ── The MarketSync "brain": live operating report from THIS store's own data ──
// One place that joins sales, commissions, leads, inventory, reconditioning, tasks
// and appraisals so the assistant can answer "how are we doing / who needs coaching
// / who do I call today" from real numbers. Queried on demand (a tool) so it never
// bloats an ordinary chat turn. Everything is scoped to the dealership; bounded with
// limits so it stays fast and cheap.
const REPORT_TOPICS = ['overview', 'sales', 'commissions', 'reps', 'leads', 'inventory', 'recon', 'tasks', 'appraisals', 'trends', 'priorities', 'pricing', 'equity', 'marketing_roi']
async function buildDealershipReport(dealershipId, topicRaw, { isMgr = true } = {}) {
  let topic = REPORT_TOPICS.includes(topicRaw) ? topicRaw : 'overview'
  // Reps can't pull the finance/per-rep views — steer them to leads for those asks.
  const FINANCE_TOPICS = ['sales', 'commissions', 'reps']
  if (!isMgr && FINANCE_TOPICS.includes(topic)) {
    return JSON.stringify({ restricted: true, message: 'Sales, commission and per-rep figures are visible to managers only. Ask your manager, or ask me about leads, inventory, reconditioning or your tasks.' })
  }
  const now = Date.now()
  const d = new Date()
  const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).toISOString()
  const d30 = new Date(now - 30 * 86400000).toISOString()
  const todayEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59).toISOString()
  const money = n => Math.round(Number(n) || 0)
  const sum = (arr, f) => arr.reduce((s, x) => s + (Number(f(x)) || 0), 0)

  // Roster for name resolution (used by several sections).
  const needRoster = ['overview', 'sales', 'commissions', 'reps', 'leads', 'equity'].includes(topic)
  let staff = []
  if (needRoster) {
    const r = await supabaseAdmin.from('profiles').select('id, full_name, display_name, role, active').eq('dealership_id', dealershipId)
    staff = r.data || []
  }
  const nm = id => { const p = staff.find(x => x.id === id); return p ? (p.display_name || p.full_name || 'Rep') : 'Unassigned' }
  const out = { topic, as_of: new Date().toISOString().slice(0, 10) }

  // Sales / commissions / per-rep all derive from the same sold-deal pull.
  // Managers only — a rep's 'overview' omits the financial block entirely.
  if (isMgr && ['overview', 'sales', 'commissions', 'reps'].includes(topic)) {
    const { data: deals } = await supabaseAdmin.from('deals')
      .select('deal_status, selling_price, vehicle_commission, fni_commission, fni_products, created_by, sold_at, delivered_at, created_at')
      .eq('dealership_id', dealershipId).in('deal_status', ['sold', 'delivered']).limit(1000)
    const soldMTD = (deals || []).filter(x => (x.sold_at || x.created_at) >= monthStart)
    out.sales = {
      units_sold_mtd: soldMTD.length,
      delivered_mtd: soldMTD.filter(x => x.deal_status === 'delivered').length,
      revenue_mtd: money(sum(soldMTD, x => x.selling_price)),
      vehicle_commission_mtd: money(sum(soldMTD, x => x.vehicle_commission)),
      fni_commission_mtd: money(sum(soldMTD, x => x.fni_commission)),
      fni_penetration_mtd: soldMTD.length ? Math.round(100 * soldMTD.filter(x => x.fni_products && String(x.fni_products).trim()).length / soldMTD.length) + '%' : 'n/a',
    }
    if (['overview', 'commissions', 'reps'].includes(topic)) {
      const byRep = {}
      for (const x of soldMTD) {
        const k = x.created_by || 'unassigned'
        byRep[k] = byRep[k] || { units: 0, rev: 0, veh: 0, fni: 0 }
        byRep[k].units++; byRep[k].rev += Number(x.selling_price) || 0
        byRep[k].veh += Number(x.vehicle_commission) || 0; byRep[k].fni += Number(x.fni_commission) || 0
      }
      out.by_rep_mtd = Object.entries(byRep).sort((a, b) => b[1].units - a[1].units).slice(0, 12)
        .map(([id, s]) => ({ rep: id === 'unassigned' ? 'Unassigned' : nm(id), units: s.units, revenue: money(s.rev), commission: money(s.veh + s.fni), fni_commission: money(s.fni) }))
    }
  }

  if (['overview', 'leads'].includes(topic)) {
    const { data: leads } = await supabaseAdmin.from('leads')
      .select('source, status, adf_sent_at, created_at, contact_id').eq('dealership_id', dealershipId).gte('created_at', d30).limit(2000)
    const L = leads || []
    const bySource = {}
    for (const l of L) { const k = l.source || 'Unknown'; bySource[k] = (bySource[k] || 0) + 1 }
    // Conversion: how many of these lead contacts are now sold/delivered.
    const cids = [...new Set(L.map(l => l.contact_id).filter(Boolean))]
    let soldFromLeads = 0
    if (cids.length) {
      const { data: cs } = await supabaseAdmin.from('contacts').select('id, status').in('id', cids)
      const soldSet = new Set((cs || []).filter(c => ['sold', 'fni', 'delivered'].includes(c.status)).map(c => c.id))
      soldFromLeads = soldSet.size
    }
    out.leads_30d = {
      total: L.length,
      waiting_on_delivery: L.filter(l => !l.adf_sent_at).length,
      by_source: Object.entries(bySource).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([s, n]) => ({ source: s, count: n })),
      converted_to_sold: soldFromLeads,
      conversion_rate: L.length ? Math.round(100 * soldFromLeads / L.length) + '%' : 'n/a',
    }
    // Unworked leads: contacts still uncontacted with an open speed-to-lead task overdue.
    const { data: unworked } = await supabaseAdmin.from('contacts')
      .select('id, assigned_rep, status').eq('dealership_id', dealershipId).eq('status', 'uncontacted').gte('created_at', d30).limit(500)
    out.leads_30d.uncontacted = (unworked || []).length
    out.leads_30d.unassigned = (unworked || []).filter(c => !c.assigned_rep).length
  }

  if (['overview', 'inventory'].includes(topic)) {
    const { data: inv } = await supabaseAdmin.from('inventory')
      .select('year, make, model, price, image_urls, photo_score, created_at, lot_date').eq('dealership_id', dealershipId).eq('status', 'available').limit(2000)
    const list = inv || []
    const pc = v => Array.isArray(v.image_urls) ? v.image_urls.filter(Boolean).length : 0
    const aged = list.filter(v => { const ref = v.lot_date || v.created_at; return ref && (now - new Date(ref)) > 60 * 86400000 })
    out.inventory = {
      available: list.length,
      aged_60plus: aged.length,
      aged_examples: aged.slice(0, 10).map(v => [v.year, v.make, v.model].filter(Boolean).join(' ')),
      thin_photos: list.filter(v => pc(v) < 4 || (v.photo_score != null && v.photo_score < 50)).length,
      missing_price: list.filter(v => !v.price || Number(v.price) === 0).length,
    }
  }

  if (['overview', 'recon'].includes(topic)) {
    const { data: recon } = await supabaseAdmin.from('recon')
      .select('stage, stage_since, delivery_at, deal_id, inventory:inventory_id(year, make, model, status)').eq('dealership_id', dealershipId).limit(500)
    const R = (recon || []).filter(r => r.inventory)
    const byStage = {}
    for (const r of R) { byStage[r.stage] = (byStage[r.stage] || 0) + 1 }
    const stalled = R.filter(r => r.stage_since && (now - new Date(r.stage_since)) > 3 * 86400000)
    const getReady = R.filter(r => r.deal_id || r.delivery_at)
    out.reconditioning = {
      in_recon: R.length,
      by_stage: byStage,
      stalled_3plus_days: stalled.length,
      get_ready_for_delivery: getReady.length,
      get_ready_examples: getReady.slice(0, 10).map(r => [r.inventory.year, r.inventory.make, r.inventory.model].filter(Boolean).join(' ')),
    }
  }

  if (['overview', 'tasks'].includes(topic)) {
    const nowIso = new Date().toISOString()
    const { data: tasks } = await supabaseAdmin.from('crm_tasks')
      .select('title, type, due_at, done, assigned_to, contact_id').eq('dealership_id', dealershipId).eq('done', false).lte('due_at', todayEnd).order('due_at', { ascending: true }).limit(200)
    const T = tasks || []
    const overdue = T.filter(t => t.due_at && t.due_at < nowIso)
    out.tasks = {
      open_due_today_or_earlier: T.length,
      overdue: overdue.length,
      appointments_today: T.filter(t => t.type === 'appointment').length,
      // Who to call today — a short actionable list (contact names resolved).
    }
    const cids = [...new Set(T.slice(0, 40).map(t => t.contact_id).filter(Boolean))]
    let cName = {}
    if (cids.length) {
      const { data: cs } = await supabaseAdmin.from('contacts').select('id, full_name').in('id', cids)
      cName = Object.fromEntries((cs || []).map(c => [c.id, c.full_name || 'Customer']))
    }
    out.tasks.top = T.slice(0, 12).map(t => ({ who: t.contact_id ? (cName[t.contact_id] || 'Customer') : '—', task: t.title || t.type, due: t.due_at ? t.due_at.slice(0, 10) : null, overdue: !!(t.due_at && t.due_at < nowIso) }))
  }

  if (['overview', 'appraisals'].includes(topic)) {
    const { data: appr } = await supabaseAdmin.from('trade_appraisals')
      .select('make, model, year, suggested_offer, disposition, created_at').eq('dealership_id', dealershipId).gte('created_at', d30).order('created_at', { ascending: false }).limit(200)
    const A = appr || []
    out.appraisals_30d = {
      count: A.length,
      total_suggested_offers: money(sum(A, x => x.suggested_offer)),
      wholesale: A.filter(x => x.disposition === 'wholesale').length,
      recent: A.slice(0, 8).map(x => ({ vehicle: [x.year, x.make, x.model].filter(Boolean).join(' '), offer: money(x.suggested_offer) })),
    }
  }

  // Trends: this period vs the prior one, so "are we up/down / why did X drop" is answerable.
  if (topic === 'trends') {
    const pct = (cur, prev) => prev ? Math.round(((cur - prev) / prev) * 100) : (cur ? 100 : 0)
    const d60 = new Date(now - 60 * 86400000).toISOString()
    // Sales (manager-only): this calendar month vs last.
    if (isMgr) {
      const lastMonthStart = new Date(d.getFullYear(), d.getMonth() - 1, 1).toISOString()
      const { data: deals } = await supabaseAdmin.from('deals')
        .select('selling_price, sold_at, created_at').eq('dealership_id', dealershipId)
        .in('deal_status', ['sold', 'delivered']).gte('sold_at', lastMonthStart).limit(1000)
      const bucket = (a, b) => (deals || []).filter(x => { const t = x.sold_at || x.created_at; return t >= a && t < b })
      const thisM = (deals || []).filter(x => (x.sold_at || x.created_at) >= monthStart)
      const lastM = bucket(lastMonthStart, monthStart)
      out.sales_trend = {
        units_this_month: thisM.length, units_last_month: lastM.length, units_change_pct: pct(thisM.length, lastM.length),
        revenue_this_month: money(sum(thisM, x => x.selling_price)), revenue_last_month: money(sum(lastM, x => x.selling_price)),
      }
    }
    // Leads: last 30 days vs the 30 before that, incl. which sources moved.
    const { data: leads } = await supabaseAdmin.from('leads')
      .select('created_at, source').eq('dealership_id', dealershipId).gte('created_at', d60).limit(4000)
    const cur = (leads || []).filter(l => l.created_at >= d30)
    const prev = (leads || []).filter(l => l.created_at < d30)
    const srcCur = {}, srcPrev = {}
    for (const l of cur) { const k = l.source || 'Unknown'; srcCur[k] = (srcCur[k] || 0) + 1 }
    for (const l of prev) { const k = l.source || 'Unknown'; srcPrev[k] = (srcPrev[k] || 0) + 1 }
    const srcs = [...new Set([...Object.keys(srcCur), ...Object.keys(srcPrev)])]
    out.leads_trend = {
      last_30d: cur.length, prior_30d: prev.length, change_pct: pct(cur.length, prev.length),
      by_source: srcs.map(s => ({ source: s, now: srcCur[s] || 0, prior: srcPrev[s] || 0, change: (srcCur[s] || 0) - (srcPrev[s] || 0) }))
        .sort((a, b) => Math.abs(b.change) - Math.abs(a.change)).slice(0, 6),
    }
  }

  // Priorities: a ranked "what should I do today" list synthesised across the store.
  if (topic === 'priorities') {
    const nowIso = new Date().toISOString()
    const actions = []
    const { data: unworked } = await supabaseAdmin.from('contacts')
      .select('full_name, created_at').eq('dealership_id', dealershipId).eq('status', 'uncontacted').order('created_at', { ascending: true }).limit(200)
    if ((unworked || []).length) actions.push({ priority: 'high', area: 'leads', action: `${unworked.length} uncontacted lead(s) need a first touch`, examples: (unworked || []).slice(0, 5).map(c => c.full_name || 'Lead') })
    const { data: overdue } = await supabaseAdmin.from('crm_tasks')
      .select('id').eq('dealership_id', dealershipId).eq('done', false).lt('due_at', nowIso).limit(300)
    if ((overdue || []).length) actions.push({ priority: 'high', area: 'tasks', action: `${overdue.length} overdue follow-up task(s)` })
    const { data: inv } = await supabaseAdmin.from('inventory')
      .select('year, make, model, price, created_at, lot_date').eq('dealership_id', dealershipId).eq('status', 'available').limit(2000)
    const age = v => { const ref = v.lot_date || v.created_at; return ref ? Math.floor((now - new Date(ref)) / 86400000) : 0 }
    const aged60 = (inv || []).filter(v => age(v) >= 60 && age(v) < 90)
    const aged90 = (inv || []).filter(v => age(v) >= 90)
    if (aged90.length) actions.push({ priority: 'high', area: 'inventory', action: `${aged90.length} unit(s) 90+ days old — wholesale/auction candidates`, examples: aged90.slice(0, 5).map(v => [v.year, v.make, v.model].filter(Boolean).join(' ')) })
    if (aged60.length) actions.push({ priority: 'medium', area: 'inventory', action: `${aged60.length} unit(s) 60–90 days — consider a price drop`, examples: aged60.slice(0, 5).map(v => [v.year, v.make, v.model].filter(Boolean).join(' ')) })
    const { data: acts } = await supabaseAdmin.from('ai_activity')
      .select('price_flagged, created_at').eq('dealership_id', dealershipId).order('created_at', { ascending: false }).limit(400)
    const flagged = (acts || []).filter(a => a.price_flagged && (now - new Date(a.created_at)) < 3 * 86400000).length
    if (flagged) actions.push({ priority: 'medium', area: 'pricing', action: `${flagged} unit(s) recently flagged as priced off market` })
    const { data: recon } = await supabaseAdmin.from('recon')
      .select('stage_since, inventory:inventory_id(status)').eq('dealership_id', dealershipId).limit(500)
    const stalled = (recon || []).filter(r => r.inventory && r.stage_since && (now - new Date(r.stage_since)) > 3 * 86400000)
    if (stalled.length) actions.push({ priority: 'medium', area: 'reconditioning', action: `${stalled.length} car(s) stalled 3+ days in reconditioning` })
    if (isMgr) {
      const { data: undel } = await supabaseAdmin.from('deals').select('id').eq('dealership_id', dealershipId).eq('deal_status', 'sold').limit(300)
      if ((undel || []).length) actions.push({ priority: 'medium', area: 'delivery', action: `${undel.length} sold deal(s) awaiting delivery` })
    }
    const rank = { high: 0, medium: 1, low: 2 }
    out.priorities = actions.length ? actions.sort((a, b) => rank[a.priority] - rank[b.priority]) : [{ priority: 'low', area: 'all', action: 'Nothing urgent — lot, leads, recon and tasks are current.' }]
  }

  // Pricing: per-unit "what to do with this car" — discount / wholesale / auction /
  // fix listing — from days-on-lot, recent off-market price flags, and missing prices.
  if (topic === 'pricing') {
    const { data: inv } = await supabaseAdmin.from('inventory')
      .select('id, year, make, model, trim, price, created_at, lot_date, status').eq('dealership_id', dealershipId).eq('status', 'available').limit(2000)
    const list = inv || []
    const age = v => { const ref = v.lot_date || v.created_at; return ref ? Math.floor((now - new Date(ref)) / 86400000) : 0 }
    // Recent off-market price flags (from the pricing engine's activity log), keyed by unit.
    const { data: acts } = await supabaseAdmin.from('ai_activity')
      .select('inventory_id, price_flagged, created_at').eq('dealership_id', dealershipId).eq('price_flagged', true).order('created_at', { ascending: false }).limit(500)
    const flaggedIds = new Set((acts || []).filter(a => a.inventory_id && (now - new Date(a.created_at)) < 14 * 86400000).map(a => a.inventory_id))
    const label = v => [v.year, v.make, v.model, v.trim].filter(Boolean).join(' ')
    const rec = v => {
      const a = age(v)
      if (!v.price || Number(v.price) === 0) return { action: 'add a price', why: 'no price set — invisible to shoppers filtering by price', priority: 'high' }
      if (a >= 90) return { action: 'wholesale / auction', why: `${a} days on lot — carrying cost is eating the gross`, priority: 'high' }
      if (flaggedIds.has(v.id)) return { action: 'reprice to market', why: 'flagged as priced above the live market', priority: 'high' }
      if (a >= 60) return { action: 'price drop', why: `${a} days on lot — a reduction now beats a bigger cut later`, priority: 'medium' }
      if (a >= 45) return { action: 'watch / refresh', why: `${a} days — refresh photos/copy and consider a small drop`, priority: 'low' }
      return null
    }
    const scored = list.map(v => ({ v, a: age(v), r: rec(v) })).filter(x => x.r)
    const pr = { high: 0, medium: 1, low: 2 }
    scored.sort((a, b) => pr[a.r.priority] - pr[b.r.priority] || b.a - a.a)

    // Live market-comp layer: for the top reprice-worthy units (aged or off-market
    // flagged, with a price + full YMM), pull the live used-market median so the AI
    // can name a concrete reprice TARGET, not just "consider a drop". Capped + gated
    // on MarketCheck being enabled/allowed so it stays cheap and never blocks the report.
    const marketByUnit = {}
    try {
      if (marketcheckEnabled() && await marketcheckAllowed(dealershipId)) {
        const { data: dlr } = await supabaseAdmin.from('dealerships').select('country, postal_code').eq('id', dealershipId).maybeSingle()
        const isUS = String(dlr?.country || '').toUpperCase() === 'US'
        const zip = (dlr?.postal_code || '').replace(/\s/g, '') || null
        const targets = scored.filter(x => x.v.price > 0 && x.v.make && x.v.model && (x.r.action === 'reprice to market' || x.r.action === 'price drop' || x.r.action.startsWith('wholesale'))).slice(0, 6)
        for (const x of targets) {
          if (!(await marketcheckAllowed(dealershipId))) break
          const st = await marketcheckMarketStats({ make: x.v.make, model: x.v.model, year: x.v.year, trim: x.v.trim, zip, radius: 250, isUS }).catch(() => null)
          await recordMarketcheckCall(dealershipId)
          const med = st?.price?.median
          if (med && Number(med) > 0) {
            const delta = Math.round(Number(x.v.price) - Number(med))
            marketByUnit[x.v.id] = {
              comps: st.count, market_median: money(med),
              vs_market: delta > 0 ? `$${delta.toLocaleString()} above market` : delta < 0 ? `$${Math.abs(delta).toLocaleString()} below market` : 'at market',
              suggested_target: money(med), avg_days_on_market: st.dom?.median != null ? Math.round(st.dom.median) : null,
            }
          }
        }
      }
    } catch { /* market layer is best-effort — never fails the pricing report */ }

    out.pricing = {
      available: list.length,
      action_count: scored.length,
      wholesale_candidates: scored.filter(x => x.r.action.startsWith('wholesale')).length,
      discount_candidates: scored.filter(x => x.r.action === 'price drop' || x.r.action === 'reprice to market').length,
      market_data: Object.keys(marketByUnit).length ? 'live comps included for top reprice candidates' : (marketcheckEnabled() ? 'no live comps matched' : 'live market comps unavailable (MarketCheck not enabled)'),
      units: scored.slice(0, 20).map(x => ({ vehicle: label(x.v), days_on_lot: x.a, price: money(x.v.price), action: x.r.action, why: x.r.why, priority: x.r.priority, ...(marketByUnit[x.v.id] ? { market: marketByUnit[x.v.id] } : {}) })),
    }
    if (!scored.length) out.pricing.note = 'No pricing action needed right now — nothing aged or flagged off-market.'
  }

  // Equity: the "who to call" upgrade list — delivered customers in a positive-equity
  // or lease-maturing position, ranked by equity (reuses the Equity Radar engine).
  if (topic === 'equity') {
    if (!isMgr) return JSON.stringify({ restricted: true, message: 'The equity / upgrade radar is a manager view. Ask your manager, or ask me about your own leads and tasks.' })
    try {
      const { items } = await buildEquityRadar(dealershipId)
      out.equity = {
        opportunities: items.length,
        high_equity: items.filter(i => /high equity/i.test(i.tier || '')).length,
        lease_maturing: items.filter(i => i.months_remaining != null && i.months_remaining <= 6).length,
        who_to_call: items.slice(0, 15).map(i => ({
          who: i.name, phone: i.reachable ? (i.phone || null) : null, reachable: i.reachable,
          current_vehicle: i.vehicle, equity: money(i.equity), tier: i.tier,
          months_remaining: i.months_remaining ?? null, rep: i.assigned_rep ? nm(i.assigned_rep) : 'Unassigned',
        })),
      }
      if (!items.length) out.equity.note = 'No equity opportunities yet — add lease/finance details on delivered customers to populate the radar.'
    } catch (e) {
      out.equity = { error: 'Could not compute the equity radar right now.' }
    }
  }

  if (topic === 'marketing_roi') {
    if (!isMgr) return JSON.stringify({ restricted: true, message: 'Marketing ROI is a manager view. Ask your manager, or ask me about your own leads and tasks.' })
    try {
      const roi = await buildMarketingRoi(dealershipId, { days: 90 })
      if (!roi.has_spend) {
        out.marketing_roi = { note: 'No ad spend entered yet, so ROI can\'t be computed. The dealer can add monthly spend per channel under Reports → Marketing ROI; leads and sales by channel are still shown there.', channels_by_sales: roi.rows.slice(0, 8).map(r => ({ channel: r.channel, leads: r.leads, sales: r.sales, revenue: money(r.revenue) })) }
      } else {
        const withSpend = roi.rows.filter(r => r.spend > 0)
        out.marketing_roi = {
          window: 'last 90 days', avg_gross_assumption: money(roi.avg_gross),
          total_spend: money(roi.totals.spend), total_sales: roi.totals.sales, total_est_gross: money(roi.totals.est_gross), blended_roi_pct: roi.totals.roi_pct,
          best_channel: withSpend.slice().sort((a, b) => (b.roi_pct ?? -1e9) - (a.roi_pct ?? -1e9))[0]?.channel || null,
          by_channel: roi.rows.slice(0, 10).map(r => ({
            channel: r.channel, spend: money(r.spend), leads: r.leads, sales: r.sales,
            cost_per_lead: r.cost_per_lead, cost_per_sale: r.cost_per_sale,
            revenue: money(r.revenue), est_gross: money(r.est_gross), roi_pct: r.roi_pct,
          })),
        }
      }
    } catch (e) {
      out.marketing_roi = { error: 'Could not compute marketing ROI right now.' }
    }
  }

  return JSON.stringify(out).slice(0, 4500)
}

async function runAssistantTool(name, input, { dealershipId, isOwner, isUS, isMgr }) {
  // The dealership report reads our OWN database — never gated by MarketCheck.
  if (name === 'dealership_report') {
    try { return await buildDealershipReport(dealershipId, input?.topic, { isMgr: !!isMgr }) }
    catch (e) { console.warn('[assistant] dealership_report failed:', e.message); return 'Could not pull that report right now.' }
  }
  if (!marketcheckEnabled()) return 'Live market data (MarketCheck) is not configured on this account.'
  if (!(await marketcheckAllowed(dealershipId, isOwner))) return 'The market-data lookup limit has been reached for now — try again later.'
  try {
    if (name === 'decode_vin') {
      const specs = await marketcheckDecodeVin(input?.vin)
      await recordMarketcheckCall(dealershipId)   // request billed even if empty
      if (!specs) return 'No specs found for that VIN.'
      const keep = ['year', 'make', 'model', 'trim', 'body_type', 'body_subtype', 'drivetrain', 'transmission', 'engine', 'doors', 'fuel_type', 'city_mpg', 'highway_mpg', 'msrp', 'vehicle_type']
      const out = {}; for (const k of keep) if (specs[k] != null) out[k] = specs[k]
      return JSON.stringify(Object.keys(out).length ? out : specs).slice(0, 1500)
    }
    if (name === 'predict_price') {
      const p = await marketcheckPredictPrice({ vin: input?.vin, miles: input?.miles })
      await recordMarketcheckCall(dealershipId)
      return p ? JSON.stringify(p) : 'No price prediction available for that VIN.'
    }
    if (name === 'market_snapshot') {
      const s = await marketcheckMarketStats({ make: input?.make, model: input?.model, year: input?.year, trim: input?.trim, isUS })
      await recordMarketcheckCall(dealershipId)
      return s ? JSON.stringify(s) : 'No market data found for that make/model.'
    }
  } catch {
    return 'That lookup failed — the market-data service may be busy.'
  }
  return 'Unknown tool.'
}

// A vehicle we should NOT run market price comparisons on: brand-new / demo units,
// and anything at or beyond the current model year (e.g. 2026 in 2026). There is no
// meaningful used-market comp set for these, so any "% over/under market" is noise.
function skipPriceComp(vehicle) {
  const cond = (vehicle?.condition || '').toLowerCase()
  if (cond === 'new' || cond === 'demo') return true
  const yr = Number(vehicle?.year)
  return Number.isFinite(yr) && yr >= new Date().getFullYear()
}

// Minimum comparable listings before a "% to market" read is actionable. Below
// this the sample is too thin to trust — common on rare/premium trims (e.g. a
// Terrain AT4) where MarketCheck returns a handful of loosely-matched listings and
// the average reads far too low. Tunable via env. Informational reads can still
// show the number; they just won't assert "overpriced" or recommend a drop.
const PRICE_MIN_COMPS = Number(process.env.PRICE_MIN_COMPS || 8)

// Build a price-comp flag from a scraped market median, with sanity guards so a
// bad/mismatched comp set never surfaces an absurd number like "233% overpriced".
// A real dealer car is essentially never off by more than ~45% vs true market — a
// deviation that large means the scraper matched the wrong listings (wrong model,
// salvage titles, parts), so we treat it as unreliable and don't flag.
function buildPriceFlag(price, marketMedian, source, compCount, trimMatched = null) {
  if (!marketMedian || marketMedian <= 0) return null
  const pct_diff = ((Number(price) - marketMedian) / marketMedian) * 100
  // Unreliable when: too few comps, beyond ±45% (bad match), or the comps weren't
  // trim-matched and the deviation is large (pooled base trims read false).
  const reliable = (compCount == null || compCount >= PRICE_MIN_COMPS)
    && Math.abs(pct_diff) <= 45
    && !(trimMatched === false && Math.abs(pct_diff) > 15)
  return {
    flagged: reliable && Math.abs(pct_diff) > 15,
    median: marketMedian,
    pct_diff: Math.round(pct_diff * 10) / 10,
    comp_count: compCount ?? null,
    trim_matched: trimMatched,
    source,
    reliable,
  }
}

// Turn a raw Anthropic error into a clear, dealer-friendly message. The most
// common operational failure is the account running out of API credits, which
// otherwise surfaces as a cryptic 400/402 — call it out explicitly.
function aiErrorMessage(err) {
  const raw = String(err?.message || err || '')
  if (/credit balance is too low|insufficient.*credit|billing|payment/i.test(raw)) {
    return 'AI is temporarily unavailable — the AI account is out of credits. Please top up Anthropic credits to generate new reports.'
  }
  if (/rate.?limit|429|overloaded|529/i.test(raw)) {
    return 'AI is busy right now — please try again in a moment.'
  }
  return `AI request failed: ${raw}`
}

// Market median for the inventory scan — MarketCheck only (licensed, trim-matched).
// Returns { median, source, count }, or null when there's no key / no comps.
async function marketMedianForScan({ vehicle, dealer, isUS, dealershipId, isOwner, allowLive = false }) {
  if (!marketcheckEnabled()) return null
  try {
    // Routed through the cost layer: served from the shared 7-day cache when
    // possible. A live (paid) call is only made when allowLive is set — the nightly
    // refresh and button actions. Passive callers get cache-or-null (never spend).
    const { data: mc } = await getMarketData({
      dealershipId, isOwner, allowLive,
      params: {
        make: vehicle.make, model: vehicle.model, year: Number(vehicle.year),
        trim: vehicle.trim || '', mileage: vehicle.mileage ? Number(vehicle.mileage) : null,
        isUS,
      },
    })
    if (mc?.median_price) {
      // Normalise the comp median to THIS car's mileage so the "% to market" read
      // reflects like-for-like value, not the km gap between it and the comp set.
      const raw = mc.median_price
      const compMiles = mc.median_mileage ?? mc.avg_mileage ?? null
      const subjectMiles = vehicle.mileage ? Number(vehicle.mileage) : null
      const adjusted = mileageAdjustedMedian(raw, compMiles, subjectMiles, isUS) ?? raw
      return {
        median: adjusted,               // mileage-adjusted fair value for this vehicle
        raw_median: raw,                // unadjusted comp median (transparency)
        median_mileage: compMiles,
        mileage_adjusted: adjusted !== raw,
        source: 'MarketCheck', count: mc.count, matched_on: mc.matched_on || null,
      }
    }
    return null
  } catch { return null }
}

function requireDealerAdmin(req, res, next) {
  // Dealer-level access: dealer admins, owners, and managers (a manager has full
  // dealer access, just scoped to the store they're logged into).
  if (!['DEALER_ADMIN', 'OWNER', 'MANAGER'].includes(req.profile?.role)) {
    return res.status(403).json({ error: 'Dealer-level access required' })
  }
  next()
}

// Calculate median from a sorted array of numbers
function median(sorted) {
  if (!sorted.length) return null
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2
}

// Adjust a comp-set median to THIS vehicle's odometer. The comps are already
// matched on make/model/year/trim/drivetrain/engine (see marketcheckMarket), so
// mileage is the dominant remaining driver of value — an unadjusted median is why
// a low-km clean car reads "20% overpriced" against higher-km comps. Same model the
// appraisal sheet uses: value-proportional (scales with the car's tier instead of a
// flat $/km) and capped at ±30% so a bad odometer reading can't swing it wildly.
// Returns the comp median unchanged when we don't have mileage on both sides.
function mileageAdjustedMedian(compMedian, compMiles, subjectMiles, isUS) {
  const med = Number(compMedian)
  if (!(med > 0)) return null
  const cm = Number(compMiles), sm = Number(subjectMiles)
  if (!(cm > 0) || !(sm > 0)) return med
  const REF_DIST = isUS ? 125000 : 200000                 // useful-life window (mi / km)
  const SENS = Number(process.env.APPRAISE_MILEAGE_SENS || 0.5)
  const ratePerDist = (med * SENS) / REF_DIST
  let adj = Math.round((cm - sm) * ratePerDist)           // fewer km than comps → +value
  const cap = Math.round(med * 0.30)
  adj = Math.max(-cap, Math.min(cap, adj))
  return med + adj
}

// Compute the "today's briefing" digest for a dealership — the action items on
// the lot plus a one-line summary. Shared by the GET endpoint (in-dashboard card)
// and the daily-email cron. isOwner exempts the AI summary from the soft cap.
async function computeDailyDigest(dealershipId, isOwner = false) {
  const now = Date.now()
  const { data: inv } = await supabaseAdmin.from('inventory')
    .select('id, price, image_urls, photo_score, created_at, lot_date')
    .eq('dealership_id', dealershipId).eq('status', 'available')
  const list = inv || []
  const total = list.length
  const photoCount = v => Array.isArray(v.image_urls) ? v.image_urls.filter(Boolean).length : 0
  const aging = list.filter(v => { const ref = v.lot_date || v.created_at; return ref && (now - new Date(ref)) > 60 * 86400000 }).length
  const lowPhotos = list.filter(v => photoCount(v) < 4 || (v.photo_score != null && v.photo_score < 50)).length
  const noPrice = list.filter(v => !v.price || Number(v.price) === 0).length

  const since = new Date(now - 7 * 86400000).toISOString()
  const { data: leads } = await supabaseAdmin.from('leads')
    .select('id, created_at, adf_sent_at').eq('dealership_id', dealershipId).gte('created_at', since)
  const leadsWaiting = (leads || []).filter(l => !l.adf_sent_at).length
  const leads7 = (leads || []).length

  const { data: acts } = await supabaseAdmin.from('ai_activity')
    .select('price_flagged, created_at').eq('dealership_id', dealershipId)
    .order('created_at', { ascending: false }).limit(400)
  const priceFlags = (acts || []).filter(a => a.price_flagged && (now - new Date(a.created_at)) < 2 * 86400000).length

  const items = []
  if (leadsWaiting) items.push({ icon: '📬', text: `${leadsWaiting} lead${leadsWaiting > 1 ? 's' : ''} waiting for follow-up`, page: 'pipeline' })
  if (lowPhotos) items.push({ icon: '📸', text: `${lowPhotos} listing${lowPhotos > 1 ? 's' : ''} need better photos`, page: 'inv-intel' })
  if (priceFlags) items.push({ icon: '💲', text: `${priceFlags} vehicle${priceFlags > 1 ? 's' : ''} priced off market`, page: 'inv-intel' })
  if (noPrice) items.push({ icon: '⚠️', text: `${noPrice} listing${noPrice > 1 ? 's' : ''} missing a price`, page: 'inventory' })
  if (aging) items.push({ icon: '🕒', text: `${aging} unit${aging > 1 ? 's' : ''} aging 60+ days`, page: 'inv-intel' })

  let summary = null
  if (!items.length) {
    summary = 'Everything looks good today — no urgent items on the lot.'
  } else {
    const { data: dealer } = await supabaseAdmin.from('dealerships').select('ai_boost_active').eq('id', dealershipId).maybeSingle()
    const aiBoost = isOwner || !!dealer?.ai_boost_active
    if (aiBoost && process.env.ANTHROPIC_API_KEY && await aiAllowed(dealershipId, isOwner)) {
      const facts = `Lot: ${total} available. ${leadsWaiting} leads waiting (${leads7} in 7 days). ${lowPhotos} weak photos. ${priceFlags} priced off market. ${noPrice} missing price. ${aging} aging 60+ days.`
      try {
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
        const msg = await Promise.race([
          anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 150, messages: [{ role: 'user', content: `You are a dealership GM's assistant writing a ONE-sentence morning briefing. Be direct and say what to tackle first. No markdown, no greeting, no lists. Data: ${facts}` }] }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('ai timeout')), 15000)),
        ])
        summary = (msg?.content?.[0]?.text || '').trim() || null
        if (summary) recordUsage(dealershipId, { ai: 1 })
      } catch { /* fall through to templated */ }
    }
    if (!summary) summary = `${items.length} thing${items.length > 1 ? 's' : ''} to look at today — start with ${items[0].text.toLowerCase()}.`
  }

  return { date: new Date().toISOString().slice(0, 10), items, summary, counts: { total, leadsWaiting, lowPhotos, priceFlags, noPrice, aging } }
}

export {
  OWNER_EMAIL, attachOemStickerToInventory, LANG_NAME, langName,
  PRODUCT_KB, ASSISTANT_TOOLS, REPORT_TOPICS,
  buildDealershipReport, runAssistantTool,
  skipPriceComp, PRICE_MIN_COMPS, buildPriceFlag, aiErrorMessage,
  marketMedianForScan, requireDealerAdmin, median, mileageAdjustedMedian,
  computeDailyDigest,
}
