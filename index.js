import express from 'express'
import cors from 'cors'
import { createClient } from '@supabase/supabase-js'
import { sessionManager } from './sessions.js'
import linesRouter from './routes/lines.js'

const app = express()
app.use(cors())
app.use(express.json({ limit: '10mb' }))

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// --- Heartbeat: update last_ping_at in Supabase every 5 minutes ---
// Proves the Baileys process is alive regardless of message activity.
setInterval(async () => {
  try {
    const sessions = sessionManager.getAll()
    for (const s of sessions) {
      if (s.status !== 'connected') continue
      await supabase.from('lines').update({ last_ping_at: new Date().toISOString() }).eq('id', s.lineId)
    }
  } catch {}
}, 5 * 60 * 1000)

app.get('/health', (_, res) => {
  const sessions = sessionManager.getAll()
  res.json({
    ok: true,
    sessions: sessionManager.count(),
    lines: sessions.map(s => ({
      lineId: s.lineId,
      status: s.status,
      phone: s.phone,
      lastMessageAt: s.lastMessageAt,
      zombieSuspected: s.zombieSuspected,
    })),
  })
})

// Proxy diagnostic endpoint
app.get('/proxy-check', async (req, res) => {
  const secret = process.env.INTERNAL_SECRET
  if (secret && req.headers['x-internal-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  const proxyUrl = process.env.PROXY_URL
  if (!proxyUrl) return res.json({ configured: false })

  try {
    const { HttpsProxyAgent } = await import('https-proxy-agent')
    const agent = new HttpsProxyAgent(proxyUrl)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10000)
    const r = await fetch('https://api.ipify.org?format=json', { agent, signal: controller.signal })
    clearTimeout(timeout)
    const json = await r.json()
    res.json({ configured: true, working: true, proxyIp: json.ip })
  } catch (err) {
    res.json({ configured: true, working: false, error: err.message })
  }
})

// Auth middleware for /lines routes (QR page is public — UUID acts as token)
app.use('/lines', (req, res, next) => {
  if (req.path.endsWith('/qr-page') && req.method === 'GET') return next()
  const secret = process.env.INTERNAL_SECRET
  if (secret && req.headers['x-internal-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  next()
})

// POST /send — send a WhatsApp message via a connected session
// Inbound-only: no cold outbound checks needed. Only replies to leads from ads.
app.post('/send', (req, res, next) => {
  const secret = process.env.INTERNAL_SECRET
  if (secret && req.headers['x-internal-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  next()
}, async (req, res) => {
  const { lineId, to, text } = req.body
  if (!lineId || !to || !text) {
    return res.status(400).json({ error: 'lineId, to, and text are required' })
  }
  const session = sessionManager.get(lineId)
  if (!session?.socket || session.status !== 'connected') {
    return res.status(400).json({ error: 'Session not connected' })
  }
  try {
    const jid = to.replace(/\D/g, '') + '@s.whatsapp.net'

    // Simulate typing — but not always (humans sometimes send quick replies)
    const skipTyping = text.length < 30 && Math.random() < 0.4
    if (!skipTyping) {
      try {
        await session.socket.presenceSubscribe(jid)
        await session.socket.sendPresenceUpdate('composing', jid)
        const charMs = 40 + Math.random() * 30
        const typeDuration = Math.max(Math.min(text.length * charMs, 8000), 800) + Math.random() * 1000
        await new Promise(r => setTimeout(r, typeDuration))
        await session.socket.sendPresenceUpdate('paused', jid)
        await new Promise(r => setTimeout(r, 200 + Math.random() * 600))
      } catch {}
    }

    await session.socket.sendMessage(jid, { text })
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.use('/lines', linesRouter)

const PORT = process.env.PORT || 3001
app.listen(PORT, async () => {
  console.log(`[Capta Baileys] running on :${PORT}`)

  // Auto-reconnect all active lines on startup
  try {
    const supabase = createClient(
      process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    )
    const { data: lines } = await supabase
      .from('lines')
      .select('id, name')
      .eq('is_active', true)

    if (lines?.length) {
      console.log(`[Capta Baileys] Auto-reconnecting ${lines.length} active line(s)...`)
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        const staggerDelay = i * (15000 + Math.random() * 30000)
        setTimeout(() => {
          sessionManager.create(line.id).catch(err =>
            console.error(`[Capta Baileys] Failed to reconnect line ${line.name}:`, err.message)
          )
        }, staggerDelay)
      }
    }
  } catch (err) {
    console.error('[Capta Baileys] Auto-reconnect failed:', err.message)
  }
})
