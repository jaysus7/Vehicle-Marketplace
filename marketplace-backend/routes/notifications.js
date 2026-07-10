import { supabaseAdmin } from '../shared.js'
import { requireAuth } from '../middleware.js'

export function registerNotifications(app) {
  // GET /notifications — fetch recent notifications for the current dealership
  // Returns up to 50, newest first. Includes read + unread.
  app.get('/notifications', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })

    const { data, error } = await supabaseAdmin
      .from('notifications')
      .select('id, type, title, body, link_page, link_filter, link_url, read, created_at')
      .eq('dealership_id', req.dealershipId)
      .or(`target_user_id.is.null,target_user_id.eq.${req.user.id}`)
      .order('created_at', { ascending: false })
      .limit(50)

    if (error) return res.status(500).json({ error: error.message })
    res.json(data || [])
  })

  // GET /notifications/unread-count — lightweight poll for badge
  app.get('/notifications/unread-count', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.json({ count: 0 })

    const { count, error } = await supabaseAdmin
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('dealership_id', req.dealershipId)
      .or(`target_user_id.is.null,target_user_id.eq.${req.user.id}`)
      .eq('read', false)

    if (error) return res.json({ count: 0 })
    res.json({ count: count || 0 })
  })

  // POST /notifications/:id/read — mark one notification as read
  app.post('/notifications/:id/read', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })

    const { error } = await supabaseAdmin
      .from('notifications')
      .update({ read: true })
      .eq('id', req.params.id)
      .eq('dealership_id', req.dealershipId)

    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true })
  })

  // POST /notifications/read-all — mark all as read
  app.post('/notifications/read-all', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })

    const { error } = await supabaseAdmin
      .from('notifications')
      .update({ read: true })
      .eq('dealership_id', req.dealershipId)
      .or(`target_user_id.is.null,target_user_id.eq.${req.user.id}`)
      .eq('read', false)

    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true })
  })

  // DELETE /notifications/:id — dismiss a single notification
  app.delete('/notifications/:id', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })

    const { error } = await supabaseAdmin
      .from('notifications')
      .delete()
      .eq('id', req.params.id)
      .eq('dealership_id', req.dealershipId)

    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true })
  })
}
