// Centralized audit log — SOC 2 Type II evidence trail.
//
// Every privileged action (auth events, role changes, data mutations by admins,
// billing changes, team management) is appended here. Rows are immutable once
// written (no UPDATE/DELETE on audit_log). The table also has an RLS policy that
// allows only the service role to insert, preventing tampering from the app layer.
//
// Usage:
//   import { audit } from '../audit.js'
//   await audit(req, 'user.login', { method: 'password' })
//
// The helper is fire-and-forget safe: failures are logged but never throw — an
// audit failure must never break the underlying operation.

import { supabaseAdmin } from './shared.js'
import { getClientIp } from './security.js'

export async function audit(req, action, meta = {}) {
  try {
    const entry = {
      action,
      actor_id: req?.user?.id || null,
      actor_email: req?.user?.email || null,
      dealership_id: req?.dealershipId || null,
      ip: req ? getClientIp(req) : null,
      user_agent: req?.headers?.['user-agent']?.slice(0, 500) || null,
      meta: Object.keys(meta).length ? meta : null,
      created_at: new Date().toISOString()
    }
    const { error } = await supabaseAdmin.from('audit_log').insert(entry)
    if (error) console.warn('[audit] insert failed:', error.message, '— action:', action)
  } catch (e) {
    console.warn('[audit] unexpected error:', e.message, '— action:', action)
  }
}

// Well-known action constants — use these instead of raw strings so grepping for
// audit events is reliable and typos are caught at import time.
export const AuditAction = Object.freeze({
  // Auth
  USER_LOGIN:             'user.login',
  USER_LOGIN_FAILED:      'user.login_failed',
  USER_LOGOUT:            'user.logout',
  USER_REGISTER:          'user.register',
  PASSWORD_RESET_REQUEST: 'user.password_reset_request',
  PASSWORD_RESET_DONE:    'user.password_reset_done',
  PASSWORD_CHANGED:       'user.password_changed',
  MFA_ENROLLED:           'user.mfa_enrolled',
  MFA_DISABLED:           'user.mfa_disabled',
  MFA_CHALLENGE_PASSED:   'user.mfa_challenge_passed',
  MFA_CHALLENGE_FAILED:   'user.mfa_challenge_failed',
  PASSKEY_REGISTERED:     'user.passkey_registered',
  PASSKEY_DELETED:        'user.passkey_deleted',
  SESSIONS_REVOKED:       'user.sessions_revoked',

  // Team management (admin actions)
  TEAM_MEMBER_INVITED:    'team.member_invited',
  TEAM_MEMBER_REMOVED:    'team.member_removed',

  // Profile
  PROFILE_UPDATED:        'profile.updated',
  AVATAR_UPLOADED:        'profile.avatar_uploaded',

  // Billing
  SUBSCRIPTION_CREATED:   'billing.subscription_created',
  SUBSCRIPTION_CANCELLED: 'billing.subscription_cancelled',
  SUBSCRIPTION_UPDATED:   'billing.subscription_updated',

  // Inventory / listings
  INVENTORY_SYNC:         'inventory.sync',
  LISTING_CREATED:        'listing.created',
  LISTING_SOLD:           'listing.sold',
  LISTING_DELETED:        'listing.deleted',

  // Admin / system
  ADMIN_DATA_EXPORT:      'admin.data_export',
})
