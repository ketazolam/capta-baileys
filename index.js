import express from 'express'
import cors from 'cors'
import { createClient } from '@supabase/supabase-js'
import { sessionManager } from './sessions.js'
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
    const jid = to.replace(/\D/g, '') + '@s.whatsapp.net'
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
