import { Router } from 'express'
import { sessionManager, getWarmUpDay } from '../sessions.js'
import QRCode from 'qrcode'

const router = Router()

// GET /lines — list all active sessions
router.get('/', (req, res) => {
  res.json(sessionManager.getAll())
})

// POST /lines/:lineId/start — start a session
router.post('/:lineId/start', async (req, res) => {
  const { lineId } = req.params
  try {
    const session = await sessionManager.create(lineId)
    res.json({ ok: true, status: session.status })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /lines/:lineId/qr — get QR as base64 image
router.get('/:lineId/qr', async (req, res) => {
  const { lineId } = req.params
  const session = sessionManager.get(lineId)

  if (!session) return res.status(404).json({ error: 'Session not found' })
  if (!session.qr) return res.status(200).json({ status: session.status, qr: null })

  try {
    const qrDataUrl = await QRCode.toDataURL(session.qr, { width: 300, margin: 2 })
    res.json({ qr: qrDataUrl, status: session.status })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /lines/:lineId/status
router.get('/:lineId/status', (req, res) => {
  const { lineId } = req.params
  const session = sessionManager.get(lineId)
  if (!session) return res.json({ status: 'not_started' })
  res.json({ status: session.status, phone: session.phone, hasQR: !!session.qr })
})

// GET /lines/:lineId/health — antiban health status
router.get('/:lineId/health', (req, res) => {
  const { lineId } = req.params
  const session = sessionManager.get(lineId)
  if (!session) return res.status(404).json({ error: 'Session not found' })

  const antiban = session.antiban
  if (!antiban) return res.json({ status: 'no_antiban' })

  try {
    const health = antiban.getHealthStatus?.() || {}
    const warmUpDay = getWarmUpDay(antiban)
    const warmUpState = antiban.exportWarmUpState?.() || {}
    res.json({
      risk: health.risk || 'unknown',
      score: health.score ?? null,
      recommendation: health.recommendation || null,
      warmUpDay,
      warmUpStartDate: warmUpState.startDate || null,
      messagestoday: warmUpState.messagesToday ?? null,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// DELETE /lines/:lineId — logout and delete session
router.delete('/:lineId', async (req, res) => {
  const { lineId } = req.params
  try {
    await sessionManager.delete(lineId)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router
