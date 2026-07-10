/**
 * Shared helper for writing notifications into the notifications table.
 * Import this wherever an event should surface an in-app alert.
 */
import { supabaseAdmin } from './shared.js'

/**
 * Create one notification record.
 *
 * @param {object} opts
 * @param {string} opts.dealershipId
 * @param {string} opts.type        — 'missing_info' | 'aging' | 'price_drift' | 'new_arrival' | 'competitor' | 'billing' | 'weekly_report'
 * @param {string} opts.title       — short headline (≤ 80 chars)
 * @param {string} [opts.body]      — one-sentence detail
 * @param {string} [opts.linkPage]  — dashboard page slug (e.g. 'inventory', 'ai-boost')
 * @param {string} [opts.linkFilter] — stock number or filter string to pre-fill
 * @param {string} [opts.linkUrl]   — external URL to open in a new tab (e.g. a PDF)
 */
export async function createNotification({ dealershipId, type, title, body, linkPage, linkFilter, linkUrl, targetUserId }) {
  if (!dealershipId) return
  try {
    await supabaseAdmin.from('notifications').insert({
      dealership_id: dealershipId,
      type,
      title,
      body: body || null,
      link_page: linkPage || null,
      link_filter: linkFilter || null,
      link_url: linkUrl || null,
      target_user_id: targetUserId || null,
    })
  } catch (err) {
    console.error('[notifications] Failed to create notification:', err.message)
  }
}

/**
 * Bulk-insert multiple notifications for the same dealership.
 * Skips silently if rows is empty.
 */
export async function createNotifications(rows) {
  if (!rows?.length) return
  try {
    await supabaseAdmin.from('notifications').insert(rows)
  } catch (err) {
    console.error('[notifications] Bulk insert failed:', err.message)
  }
}
