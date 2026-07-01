import { supabase, supabaseAdmin } from './shared.js'

// ── AUTH MIDDLEWARE ──
export async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'No token provided' })

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token)
    if (error || !user) return res.status(401).json({ error: 'AUTH_EXPIRED — please sign in again' })

    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('*, dealerships(*)')
      .eq('id', user.id)
      .single()

    if (profileError || !profile) return res.status(401).json({ error: 'Profile not found' })

    if (!req.path.startsWith('/billing')) {
      const isPersonal = profile.dealerships?.is_personal === true
      const useProfileBilling = !profile.dealership_id || isPersonal
      const status = useProfileBilling
        ? profile.billing_status
        : profile.dealerships?.billing_status
      const trialEndsAt = useProfileBilling
        ? profile.trial_ends_at
        : profile.dealerships?.trial_ends_at

      if (status === 'TRIALING') {
        // Self-managed trial — no card required upfront. Block once it expires.
        if (!trialEndsAt || new Date(trialEndsAt) < new Date()) {
          return res.status(402).json({ error: 'TRIAL_EXPIRED' })
        }
      } else if (status === 'INACTIVE' || status === 'PAST_DUE') {
        return res.status(402).json({ error: 'SUBSCRIPTION_REQUIRED' })
      }
    }

    req.user = user
    req.profile = profile
    req.dealershipId = profile.dealership_id
    next()
  } catch (err) {
    return res.status(500).json({ error: 'Internal server authorization error' })
  }
}
