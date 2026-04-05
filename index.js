import express from 'express'
import cors from 'cors'
import { createClient } from '@supabase/supabase-js'
import { sessionManager, getWarmUpDay, isSendingTime, variator, recentContacts, trackSent, getResponseRate } from './sessions.js'
import linesRouter from './routes/lines.js'

const app = express()
app.use(cors())
app.use(express.json({ limit: '10mb' }))

// Track daily new (cold outbound) contacts per line — prevents mass cold-messaging
const dailyNewContacts = new Map()

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
    const jid = to.replace(/\D/g, '') + '@s.whatsapp.net'
    const phoneNum = to.replace(/\D/g, '')
    const contactKey = `${lineId}:${phoneNum}`
    const isReply = recentContacts.has(contactKey)

    // Block cold outbound outside sending hours (10-18h) — but ALWAYS allow replies
    // Replies are safe: WhatsApp never penalizes responding to someone who messaged first
    if (!isReply && !isSendingTime()) {
      return res.status(429).json({ error: 'Outside sending hours (10-18h Argentina). Only replies allowed.' })
    }

    // Apply anti-ban checks before sending
    const antiban = session.antiban
    if (antiban) {
      // Warm-up restrictions (10-day protocol)
      const warmUpDay = getWarmUpDay(antiban)
      if (warmUpDay) {
        // Days 1-5: reply-only (no cold outbound to unknown contacts)
        if (warmUpDay <= 5 && !isReply) {
          return res.status(429).json({ error: `Warm-up day ${warmUpDay}: can only reply to contacts who messaged first` })
        }
        // Days 1-3: no links at all
        if (warmUpDay <= 3 && /https?:\/\/|wa\.me|bit\.ly/i.test(text)) {
          return res.status(429).json({ error: `Warm-up day ${warmUpDay}: links restricted` })
        }
      }

      // Daily new contacts cap — prevents burning a number with mass cold outbound
      if (!isReply) {
        const today = new Date().toISOString().slice(0, 10)
        const tracker = dailyNewContacts.get(lineId) || { date: today, count: 0 }
        if (tracker.date !== today) { tracker.date = today; tracker.count = 0 }
        const maxNew = warmUpDay ? Math.min(warmUpDay * 3, 20) : 20
        if (tracker.count >= maxNew) {
          return res.status(429).json({ error: `Daily new contact limit reached (${maxNew}). Only replies allowed.` })
        }
        tracker.count++
        dailyNewContacts.set(lineId, tracker)
      }

      const decision = await antiban.beforeSend(jid, text)
      if (!decision.allowed) {
        return res.status(429).json({ error: `Antiban: ${decision.reason}` })
      }
      await new Promise(r => setTimeout(r, decision.delayMs || 1500))
    }

    // Response rate check: if sending way more than receiving, pause outbound
    // A number that only sends without receiving replies is a spam signature
    if (!isReply) {
      const { rate, sent } = getResponseRate(lineId)
      if (sent >= 10 && rate < 0.5) {
        return res.status(429).json({ error: `Response rate too low (${Math.round(rate * 100)}%). Need 50%+ to continue cold outbound.` })
      }
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

    // Apply content variation — punctuation variation makes each send slightly different
    const variedText = variator.vary(text)
    await session.socket.sendMessage(jid, { text: variedText })

    if (antiban) antiban.afterSend(jid, text)
    trackSent(lineId)
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
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        // Stagger reconnections — simultaneous connects from same server = datacenter pattern
        const staggerDelay = i * (15000 + Math.random() * 30000) // 15-45s between each line
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
