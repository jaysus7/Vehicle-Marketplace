import express from 'express'
import cors from 'cors'
import { securityHeaders, corsOriginCheck } from './security.js'
import { CANONICAL_FRONTEND } from './shared.js'
import { registerRoutes as registerAuth } from './routes/auth.js'
import { registerRoutes as registerProfile } from './routes/profile.js'
import { registerRoutes as registerBlog } from './routes/blog.js'
import { registerRoutes as registerDashboard } from './routes/dashboard.js'
import { registerRoutes as registerInventory } from './routes/inventory.js'
import { registerRoutes as registerListings } from './routes/listings.js'
import { registerRoutes as registerBilling } from './routes/billing.js'
import { registerRoutes as registerFeeds } from './routes/feeds.js'
import { registerRoutes as registerSync } from './routes/sync.js'
import { registerRoutes as registerMisc } from './routes/misc.js'

const app = express()
const PORT = process.env.PORT || 10000

app.set('trust proxy', 1)
app.use(securityHeaders)
app.use(cors({ origin: corsOriginCheck, credentials: true }))

// Bounce any stale *.html requests to the canonical frontend
app.get(/\.html$/, (req, res) => {
  res.redirect(302, `${CANONICAL_FRONTEND}${req.originalUrl}`)
})

// Stripe webhook must be raw before express.json
registerBilling(app)

app.use(express.json({ limit: '25mb' }))
app.use(express.urlencoded({ extended: true, limit: '25mb' }))

// Route modules
registerAuth(app)
registerProfile(app)
registerBlog(app)
registerDashboard(app)
registerInventory(app)
registerListings(app)
registerFeeds(app)
registerSync(app)
registerMisc(app)

app.use((err, req, res, next) => {
  console.error('Unhandled Express error:', {
    path: req.path,
    method: req.method,
    message: err.message,
    stack: err.stack
  })
  if (res.headersSent) return next(err)
  res.status(500).json({ error: 'Internal server error' })
})

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Secure Marketplace engine live on port ${PORT}`))
