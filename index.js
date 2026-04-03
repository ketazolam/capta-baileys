import express from 'express'
import cors from 'cors'
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

app.use('/lines', linesRouter)

const PORT = process.env.PORT || 3001
app.listen(PORT, () => console.log(`[Capta Baileys] running on :${PORT}`))
