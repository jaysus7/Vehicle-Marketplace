import { supabaseAdmin, FRONTEND_URL } from '../shared.js'

const slugify = (s) => String(s || '')
  .toLowerCase().trim()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 80)

function requireBlogKey(req, res) {
  const expected = process.env.BLOG_API_KEY
  if (!expected) { res.status(503).json({ error: 'Blog publishing is not configured (BLOG_API_KEY unset).' }); return false }
  const got = req.get('x-api-key') || (req.get('authorization') || '').replace(/^Bearer\s+/i, '')
  if (got !== expected) { res.status(401).json({ error: 'Invalid API key' }); return false }
  return true
}

// --- Duplicate-content guard ------------------------------------------------
// The daily n8n job publishes one post per run. If its topic source repeats
// (e.g. the same "Ready" row is pulled again), we end up with several
// near-identical posts fighting for the same keyword — classic SEO
// cannibalization that suppresses the whole blog. This rejects a new post that
// is too similar to a recent one. Re-publishing the SAME slug (an edit) is
// always allowed; send header `x-blog-force: 1` to override for a genuine
// exception. Tunable via BLOG_DUP_THRESHOLD (0–1) and BLOG_DUP_WINDOW_DAYS.
const DUP_STOP = new Set(('a an the and or but for to of in on at by with your you our we us it its this that ' +
  'how why what when where which who guide guides tip tips best top ways way using use make made get new ' +
  'marketsync dealer dealers dealership dealerships').split(/\s+/))

// Significant-word token set from the title + slug combined. The slug strips
// marketing fluff down to the keyword core, so pairing it with the title
// exposes topic overlap that the title alone (with words like "Unlock",
// "Seamless") would hide.
function postTokens(slug, title) {
  const set = new Set()
  const add = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .forEach(w => { if (w.length > 2 && !DUP_STOP.has(w)) set.add(w) })
  add(title)
  add(String(slug).replace(/-/g, ' '))
  return set
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  return inter / (a.size + b.size - inter)
}

// Returns the most-similar recent post at/above the threshold, or null.
async function findNearDuplicate(slug, title) {
  const threshold = Math.min(Math.max(parseFloat(process.env.BLOG_DUP_THRESHOLD) || 0.35, 0), 1)
  const windowDays = parseInt(process.env.BLOG_DUP_WINDOW_DAYS) || 45
  const since = new Date(Date.now() - windowDays * 86400000).toISOString()
  const { data: recent, error } = await supabaseAdmin
    .from('blog_posts')
    .select('slug, title, published_at')
    .eq('status', 'published')
    .gte('published_at', since)
    .order('published_at', { ascending: false })
    .limit(100)
  if (error) return null // never block publishing on a lookup failure
  const newTokens = postTokens(slug, title)
  let worst = null
  for (const p of (recent || [])) {
    if (p.slug === slug) continue // same slug = intentional update, allow it
    const sim = jaccard(newTokens, postTokens(p.slug, p.title))
    if (sim >= threshold && (!worst || sim > worst.sim)) {
      worst = { sim, title: p.title, slug: p.slug, published_at: p.published_at }
    }
  }
  return worst ? { ...worst, threshold } : null
}

// --- Related-post cross-referencing ----------------------------------------
// Internal links between topically-related posts are the single biggest on-site
// SEO lever for a blog: they spread crawl equity, keep readers on-site, and
// signal topical authority. We rank other published posts by shared tags +
// title/slug token overlap and expose the top few. Cheap, deterministic, and
// needs nothing from n8n — it works off whatever posts already exist.
async function relatedPosts(post, limit = 4) {
  const { data: all } = await supabaseAdmin
    .from('blog_posts')
    .select('slug, title, excerpt, cover_image_url, tags, published_at')
    .eq('status', 'published')
    .order('published_at', { ascending: false })
    .limit(200)
  if (!all) return []
  const baseTokens = postTokens(post.slug, post.title)
  const baseTags = new Set((post.tags || []).map(t => String(t).toLowerCase()))
  const scored = []
  for (const p of all) {
    if (p.slug === post.slug) continue
    const tagOverlap = (p.tags || []).reduce((n, t) => n + (baseTags.has(String(t).toLowerCase()) ? 1 : 0), 0)
    const tokenSim = jaccard(baseTokens, postTokens(p.slug, p.title))
    const score = tagOverlap * 0.6 + tokenSim
    if (score > 0) scored.push({ p, score })
  }
  scored.sort((a, b) => b.score - a.score)
  let picks = scored.slice(0, limit).map(s => s.p)
  // Fall back to most-recent posts if nothing overlaps, so the section is never empty.
  if (picks.length < limit) {
    for (const p of all) {
      if (p.slug === post.slug || picks.find(x => x.slug === p.slug)) continue
      picks.push(p); if (picks.length >= limit) break
    }
  }
  return picks
}

export function registerRoutes(app) {
  // List published posts (newest first). Lightweight — no full body.
  app.get('/blog', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 100)
    let q = supabaseAdmin
      .from('blog_posts')
      .select('slug, title, excerpt, cover_image_url, author, tags, published_at')
      .eq('status', 'published')
      .order('published_at', { ascending: false })
      .limit(limit)
    if (req.query.tag) q = q.contains('tags', [req.query.tag])
    const { data, error } = await q
    if (error) return res.status(500).json({ error: error.message })
    res.json(data || [])
  })

  // Single published post (full body).
  app.get('/blog/:slug', async (req, res) => {
    const { data, error } = await supabaseAdmin
      .from('blog_posts')
      .select('*')
      .eq('slug', req.params.slug)
      .eq('status', 'published')
      .single()
    if (error || !data) return res.status(404).json({ error: 'Post not found' })
    res.json(data)
  })

  // Related posts for a given slug — topical internal-linking for SEO + engagement.
  app.get('/blog/:slug/related', async (req, res) => {
    const { data: p } = await supabaseAdmin
      .from('blog_posts').select('slug, title, tags').eq('slug', req.params.slug).eq('status', 'published').maybeSingle()
    if (!p) return res.json({ related: [] })
    const limit = Math.min(8, Math.max(1, parseInt(req.query.limit) || 4))
    const related = await relatedPosts(p, limit)
    res.json({ related: related.map(x => ({ slug: x.slug, title: x.title, excerpt: x.excerpt, cover_image_url: x.cover_image_url, published_at: x.published_at })) })
  })

  // Create / update a post (upsert on slug). For n8n.
  app.post('/blog', async (req, res) => {
    if (!requireBlogKey(req, res)) return
    const b = req.body || {}
    const title = (b.title || '').trim()
    const contentHtml = (b.content_html || b.content || b.html || '').trim()
    if (!title || !contentHtml) return res.status(400).json({ error: 'title and content_html are required' })

    const slug = slugify(b.slug || title)
    if (!slug) return res.status(400).json({ error: 'Could not derive a slug from the title' })

    // Block near-duplicate topics (SEO cannibalization) unless explicitly forced.
    const force = /^(1|true|yes)$/i.test(req.get('x-blog-force') || b.force || '')
    if (!force) {
      const dup = await findNearDuplicate(slug, title)
      if (dup) {
        return res.status(409).json({
          error: 'Near-duplicate post rejected to avoid SEO keyword cannibalization.',
          similarity: Math.round(dup.sim * 100) / 100,
          threshold: dup.threshold,
          conflicts_with: { slug: dup.slug, title: dup.title, published_at: dup.published_at },
          hint: 'Pick a distinct topic/angle, or resend with header "x-blog-force: 1" to publish anyway.'
        })
      }
    }

    const row = {
      slug,
      title,
      excerpt: b.excerpt || contentHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200),
      content_html: contentHtml,
      cover_image_url: b.cover_image_url || b.cover || b.image || null,
      author: b.author || 'MarketSync',
      tags: Array.isArray(b.tags) ? b.tags : (typeof b.tags === 'string' ? b.tags.split(',').map(t => t.trim()).filter(Boolean) : []),
      status: b.status === 'draft' ? 'draft' : 'published',
      published_at: b.published_at || new Date().toISOString(),
      updated_at: new Date().toISOString()
    }
    const { data, error } = await supabaseAdmin
      .from('blog_posts')
      .upsert(row, { onConflict: 'slug' })
      .select()
      .single()
    if (error) return res.status(500).json({ error: error.message })
    res.json({ success: true, slug: data.slug, url: `${FRONTEND_URL}/post.html?slug=${data.slug}`, post: data })
  })

  // Server-side rendered blog post — full HTML for crawlers that don't execute JavaScript.
  // Proxied under marketsync.link/blog/:slug via the frontend _redirects file.
  app.get('/ssr/blog/:slug', async (req, res) => {
    const { data: p, error } = await supabaseAdmin
      .from('blog_posts')
      .select('*')
      .eq('slug', req.params.slug)
      .eq('status', 'published')
      .single()
    if (error || !p) return res.status(404).send('<!DOCTYPE html><html><head><title>Not found</title></head><body><p>Post not found.</p></body></html>')

    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
    const url = `https://marketsync.link/blog/${esc(p.slug)}`
    const desc = esc((p.excerpt || '').slice(0, 200))
    const title = esc(p.title)
    const pubDate = p.published_at ? new Date(p.published_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : ''
    const tags = (p.tags || []).map(t => esc(t)).join(' · ')
    const cover = p.cover_image_url ? `<img src="${esc(p.cover_image_url)}" alt="${title}" style="width:100%;border-radius:12px;margin:1.5rem 0;max-height:480px;object-fit:cover;">` : ''

    // Crawlable internal links to related posts (SEO cross-referencing).
    const rel = await relatedPosts(p, 4)
    const relatedHtml = rel.length ? `<div class="related">
      <h3>Related articles</h3>
      <ul>${rel.map(r => `<li><a href="https://marketsync.link/blog/${esc(r.slug)}">${esc(r.title)}</a></li>`).join('')}</ul>
    </div>` : ''

    const ld = JSON.stringify({
      '@context': 'https://schema.org', '@type': 'BlogPosting',
      headline: p.title, description: p.excerpt || '',
      image: p.cover_image_url || undefined,
      datePublished: p.published_at, dateModified: p.updated_at || p.published_at,
      author: { '@type': 'Organization', name: p.author || 'MarketSync' },
      publisher: { '@type': 'Organization', name: 'MarketSync', logo: { '@type': 'ImageObject', url: 'https://marketsync.link/logo.png' } },
      mainEntityOfPage: url
    })

    res.set('Content-Type', 'text/html; charset=utf-8')
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — MarketSync</title>
  <meta name="description" content="${desc}">
  <link rel="canonical" href="${url}">
  <meta property="og:type" content="article">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${desc}">
  <meta property="og:url" content="${url}">
  ${p.cover_image_url ? `<meta property="og:image" content="${esc(p.cover_image_url)}">` : ''}
  <meta property="og:site_name" content="MarketSync">
  <meta name="twitter:card" content="${p.cover_image_url ? 'summary_large_image' : 'summary'}">
  <meta name="twitter:title" content="${title}">
  <meta name="twitter:description" content="${desc}">
  <meta name="robots" content="index, follow">
  <script type="application/ld+json">${ld}</script>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f8fafc;color:#1e293b;font-size:17px;line-height:1.6}
    nav{border-bottom:1px solid #e2e8f0;padding:1rem 1.5rem;display:flex;align-items:center;justify-content:space-between;background:#fff}
    .logo{font-weight:900;font-size:1.2rem;text-decoration:none;color:#1e293b}
    .logo span{color:#4f46e5}
    .back{font-size:.875rem;color:#64748b;text-decoration:none}
    main{max-width:720px;margin:3rem auto;padding:0 1.5rem 6rem}
    .meta{font-size:.8rem;color:#94a3b8;margin-bottom:1.5rem}
    h1{font-size:2.2rem;font-weight:800;line-height:1.2;margin-bottom:1rem;color:#0f172a}
    .article h2{font-size:1.5rem;font-weight:700;margin:2rem 0 .75rem;color:#1e293b}
    .article h3{font-size:1.2rem;font-weight:600;margin:1.5rem 0 .5rem;color:#1e293b}
    .article p{margin:0 0 1.1rem;line-height:1.75}
    .article ul,.article ol{margin:0 0 1.1rem 1.5rem;line-height:1.75}
    .article ul{list-style:disc}.article ol{list-style:decimal}
    .article li{margin:.35rem 0}
    .article a{color:#4f46e5}
    .article blockquote{border-left:3px solid #4f46e5;padding-left:1rem;margin:1.25rem 0;font-style:italic;color:#64748b}
    .article pre{background:#f1f5f9;padding:1rem;border-radius:.5rem;overflow-x:auto;margin:0 0 1.1rem;font-size:.85rem}
    .article code{background:#f1f5f9;padding:.15rem .4rem;border-radius:.3rem;font-size:.85em}
    .cta{margin-top:3rem;padding-top:2rem;border-top:1px solid #e2e8f0;text-align:center}
    .cta h3{font-size:1.2rem;font-weight:700;margin-bottom:.5rem}
    .cta p{font-size:.875rem;color:#64748b;margin-bottom:1rem}
    .cta a{display:inline-block;background:#4f46e5;color:#fff;font-weight:700;padding:.75rem 1.5rem;border-radius:.75rem;text-decoration:none}
    .related{margin-top:3rem;padding-top:2rem;border-top:1px solid #e2e8f0}
    .related h3{font-size:1.1rem;font-weight:700;margin-bottom:.75rem;color:#0f172a}
    .related ul{list-style:none;margin:0}
    .related li{margin:.4rem 0}
    .related a{color:#4f46e5;text-decoration:none;font-weight:600}
    .related a:hover{text-decoration:underline}
    footer{border-top:1px solid #e2e8f0;padding:2rem 1.5rem;text-align:center;font-size:.75rem;color:#94a3b8}
  </style>
</head>
<body>
  <nav>
    <a href="https://marketsync.link/" class="logo">Market<span>Sync</span></a>
    <a href="https://marketsync.link/blog.html" class="back">← All posts</a>
  </nav>
  <main>
    <div class="meta">${tags ? tags + ' · ' : ''}${pubDate}${p.author ? ' · ' + esc(p.author) : ''}</div>
    <h1>${title}</h1>
    ${cover}
    <div class="article">${p.content_html || ''}</div>
    ${relatedHtml}
    <div class="cta">
      <h3>Run your whole dealership from one platform</h3>
      <p>Website, CRM, inventory intelligence, appraisals and vehicle marketing in one system. Free 30-day trial.</p>
      <a href="https://marketsync.link/register.html">Start free trial</a>
    </div>
  </main>
  <footer>&copy; 2026 MarketSync &mdash; Not affiliated with Meta or Facebook</footer>
</body>
</html>`)
  })

  // Dynamic sitemap of all published posts — submit this URL in Google Search Console
  // so new n8n posts get crawled without touching the static sitemap.
  // Proxied under marketsync.link/blog-sitemap.xml via the frontend _redirects file.
  app.get('/blog-sitemap.xml', async (req, res) => {
    const { data } = await supabaseAdmin
      .from('blog_posts')
      .select('slug, updated_at, published_at')
      .eq('status', 'published')
      .order('published_at', { ascending: false })
      .limit(5000)
    const base = 'https://marketsync.link'
    const urls = (data || []).map(p => {
      const lastmod = (p.updated_at || p.published_at || '').slice(0, 10)
      return `  <url>\n    <loc>${base}/blog/${encodeURIComponent(p.slug)}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.7</priority>\n  </url>`
    }).join('\n')
    res.set('Content-Type', 'application/xml')
    res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`)
  })

  // Delete a post. For n8n.
  app.delete('/blog/:slug', async (req, res) => {
    if (!requireBlogKey(req, res)) return
    const { error } = await supabaseAdmin.from('blog_posts').delete().eq('slug', req.params.slug)
    if (error) return res.status(500).json({ error: error.message })
    res.json({ success: true })
  })
}
