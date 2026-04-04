import express from 'express'
import cors from 'cors'
import { createClient } from '@supabase/supabase-js'
import { sessionManager, getWarmUpDay, isActiveTime, variator } from './sessions.js'
import linesRouter from './routes/lines.js'

const app = express()
app.use(cors())
app.use(express.json({ limit: '10mb' }))

app.get('/health', (_, res) => res.json({ ok: true, sessions: sessionManager.count() }))

// Auth middleware for /lines routes
app.use('/lines', (req, res, next) => {
  const secret = process.env.INTERNAL_SECRET
  if (secret && req.headers['x-internal-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  next()
})

// POST /send — send a WhatsApp message via a connected session
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
    // Block sends outside active hours — Argentina timezone (anti-ban: no 3 AM messages)
    if (!isActiveTime()) {
      return res.status(429).json({ error: 'Outside active hours (8-23h Argentina). Try again later.' })
    }

    const jid = to.replace(/\D/g, '') + '@s.whatsapp.net'

    // Apply anti-ban checks before sending
    const antiban = session.antiban
    if (antiban) {
      // Block link/promo messages during warm-up days 1-2
      const warmUpDay = getWarmUpDay(antiban)
      if (warmUpDay && warmUpDay <= 2 && /https?:\/\/|wa\.me|bit\.ly/i.test(text)) {
        return res.status(429).json({ error: `Warm-up day ${warmUpDay}: links not allowed yet` })
      }

      const decision = await antiban.beforeSend(jid, text)
      if (!decision.allowed) {
        return res.status(429).json({ error: `Antiban: ${decision.reason}` })
      }
      await new Promise(r => setTimeout(r, decision.delayMs || 1500))
    }

    // Simulate typing — but not always (humans sometimes send quick replies)
    // Short messages (<30 chars): 40% chance of no typing indicator
    const skipTyping = text.length < 30 && Math.random() < 0.4
    if (!skipTyping) {
      try {
        await session.socket.presenceSubscribe(jid)
        await session.socket.sendPresenceUpdate('composing', jid)
        const charMs = 40 + Math.random() * 30
        const typeDuration = Math.max(Math.min(text.length * charMs, 8000), 800) + Math.random() * 1000
        await new Promise(r => setTimeout(r, typeDuration))
        // Show "paused" briefly before sending (human finishes typing, reviews, then sends)
        await session.socket.sendPresenceUpdate('paused', jid)
        await new Promise(r => setTimeout(r, 200 + Math.random() * 600))
      } catch {}
    }

    // Apply content variation — zero-width chars make each send technically unique
    const variedText = variator.vary(text)
    await session.socket.sendMessage(jid, { text: variedText })

    if (antiban) antiban.afterSend(jid, text)
    res.json({ ok: true })
  } catch (err) {
    try { session.antiban?.afterSendFailed?.(err.message) } catch {}
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
      for (const line of lines) {
        sessionManager.create(line.id).catch(err =>
          console.error(`[Capta Baileys] Failed to reconnect line ${line.name}:`, err.message)
        )
      }
    }
  } catch (err) {
    console.error('[Capta Baileys] Auto-reconnect failed:', err.message)
  }
})
