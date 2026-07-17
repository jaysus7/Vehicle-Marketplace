/**
 * Build the MarketSync sales-assistant knowledge base from the marketing site.
 *
 * Scans the content-rich marketing HTML pages, strips chrome (nav/header/footer/
 * script/style/svg) and tags, and writes a single grounding document the chatbot
 * reads at runtime. Re-run whenever the marketing copy changes:
 *     npm run build:kb
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FRONTEND = path.resolve(__dirname, '../../marketplace-frontend')
const OUT = path.resolve(__dirname, '../data/marketsync-kb.md')

// Content pages that describe what MarketSync is and does (skip login/legal/blog).
const PAGES = [
  ['index.html', 'Overview & pricing'],
  ['workflow.html', 'The MarketSync workflow (lot-to-road loop)'],
  ['features.html', 'Feature index'],
  ['compare.html', 'How MarketSync compares'],
  ['faq.html', 'FAQ'],
  ['dealer-website.html', 'Product: Dealer Website Builder'],
  ['deal-desk.html', 'Product: Deal Desk & Bill of Sale'],
  ['trade-appraisal.html', 'Product: Trade Appraisal'],
  ['automation-followups.html', 'Product: Follow-up Automation'],
  ['equity-mining.html', 'Product: Equity Mining'],
  ['inventory-intelligence.html', 'Product: Inventory Intelligence'],
  ['facebook-marketplace-poster.html', 'Product: Facebook Marketplace Auto-Poster'],
  ['crm-lead-delivery.html', 'Product: CRM & Lead Delivery'],
  ['ai-listing-copy.html', 'Product: AI Listing Copy'],
  ['ai-vision-photo-scoring.html', 'Product: AI Vision Photo Scoring'],
  ['market-price-reports.html', 'Product: Market Price Reports'],
  ['sales-pipeline.html', 'Product: Sales Pipeline'],
  ['sales-leaderboard.html', 'Product: Sales Leaderboard'],
  ['dealer-groups.html', 'Product: Dealer Groups'],
  ['dealer-inventory-sync.html', 'Product: Inventory Sync'],
  ['vin-decoder-window-stickers.html', 'Product: VIN Decoder & Window Stickers'],
  ['facebook-posting-safety.html', 'Product: Facebook Posting Safety'],
  ['upgrade.html', 'Packages & add-on pricing'],
]

const decode = (s) => s
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#3?9;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/&mdash;/g, '—').replace(/&ndash;/g, '–').replace(/&hellip;/g, '…')
  .replace(/&rsquo;/g, '’').replace(/&lsquo;/g, '‘').replace(/&[a-z]+;/g, ' ')

function extract(html) {
  let h = html
  // Keep only the body, then remove chrome + non-text blocks.
  const bodyM = h.match(/<body[^>]*>([\s\S]*)<\/body>/i)
  if (bodyM) h = bodyM[1]
  h = h
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
  // Turn block boundaries into newlines so headings/list items stay separated.
  h = h.replace(/<\/(h[1-6]|p|li|div|section|tr|td|th|summary|details)>/gi, '\n')
       .replace(/<br\s*\/?>/gi, '\n')
  h = h.replace(/<[^>]+>/g, ' ')      // strip remaining tags
  h = decode(h)
  // Collapse whitespace; drop empty / boilerplate lines.
  const lines = h.split('\n').map(l => l.replace(/\s+/g, ' ').trim())
    .filter(l => l && l.length > 1)
  // De-dupe consecutive repeats (repeated CTAs etc.)
  const out = []
  for (const l of lines) { if (out[out.length - 1] !== l) out.push(l) }
  return out.join('\n')
}

let doc = `# MarketSync — Product Knowledge Base
Source: marketsync.link marketing site. Generated ${new Date().toISOString().slice(0, 10)}.
Use ONLY this document to answer questions about MarketSync.

`
let pages = 0
for (const [file, label] of PAGES) {
  const fp = path.join(FRONTEND, file)
  if (!fs.existsSync(fp)) { console.warn('  skip (missing):', file); continue }
  const titleM = fs.readFileSync(fp, 'utf8').match(/<title>([^<]*)<\/title>/i)
  const title = titleM ? decode(titleM[1]).replace(/\s*\|\s*MarketSync.*$/i, '').trim() : label
  let text = extract(fs.readFileSync(fp, 'utf8'))
  if (text.length > 6000) text = text.slice(0, 6000) + ' …'
  doc += `\n\n## ${label} — ${title}\n(${file})\n${text}\n`
  pages++
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, doc)
console.log(`[build-kb] wrote ${OUT} — ${pages} pages, ${(doc.length / 1024).toFixed(1)} KB`)
