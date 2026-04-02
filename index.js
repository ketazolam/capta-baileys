import express from 'express'
import cors from 'cors'
import { sessionManager } from './sessions.js'
import linesRouter from './routes/lines.js'

const app = express()
app.use(cors())
app.use(express.json({ limit: '10mb' }))

app.get('/health', (_, res) => res.json({ ok: true, sessions: sessionManager.count() }))
app.use('/lines', linesRouter)

const PORT = process.env.PORT || 3001
app.listen(PORT, () => console.log(`[Capta Baileys] running on :${PORT}`))
