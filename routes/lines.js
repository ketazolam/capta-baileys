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
      messagesToday: warmUpState.messagesToday ?? null,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /lines/:lineId/qr-page — HTML page that auto-refreshes QR every 20s
// Share this URL with the operator — no 60s expiration stress
router.get('/:lineId/qr-page', async (req, res) => {
  const { lineId } = req.params
  const session = sessionManager.get(lineId)
  if (!session) return res.status(404).send('<h2>Línea no encontrada</h2>')

  let qrDataUrl = null
  if (session.qr) {
    try {
      qrDataUrl = await QRCode.toDataURL(session.qr, { width: 400, margin: 2 })
    } catch {}
  }

  const status = session.status
  const phone = session.phone || ''

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Capta — Escanear QR</title>
  <meta http-equiv="refresh" content="20">
  <style>
    body { font-family: -apple-system, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #0f0f0f; color: #fff; }
    h1 { font-size: 1.4rem; margin-bottom: 0.5rem; }
    p { color: #aaa; font-size: 0.9rem; margin: 0.3rem 0; }
    .qr { margin: 1.5rem 0; background: white; padding: 16px; border-radius: 12px; }
    .status { padding: 6px 14px; border-radius: 999px; font-size: 0.85rem; font-weight: 600; margin-top: 0.5rem; }
    .connected { background: #16a34a; }
    .waiting { background: #d97706; }
    .other { background: #6b7280; }
    .steps { background: #1a1a1a; border-radius: 12px; padding: 1rem 1.5rem; margin-top: 1rem; max-width: 360px; font-size: 0.85rem; line-height: 1.8; }
    .steps b { color: #fff; }
    .refresh { color: #555; font-size: 0.75rem; margin-top: 1rem; }
  </style>
</head>
<body>
  <h1>Vincular WhatsApp con Capta</h1>
  ${status === 'connected'
    ? `<span class="status connected">✅ Conectado como +${phone}</span><p style="margin-top:1rem">El número ya está vinculado. No hace falta escanear.</p>`
    : status === 'waiting_qr' && qrDataUrl
      ? `<div class="qr"><img src="${qrDataUrl}" width="300" height="300" /></div>
         <span class="status waiting">📱 Esperando escaneo</span>
         <div class="steps">
           <b>Cómo vincular:</b><br>
           1. Abrí WhatsApp en el celular<br>
           2. Tocá ⋮ → <b>Dispositivos vinculados</b><br>
           3. Tocá <b>Vincular dispositivo</b><br>
           4. Apuntá la cámara a este QR
         </div>`
      : `<span class="status other">⏳ ${status}</span><p>Esperando QR... la página se actualiza sola.</p>`
  }
  <p class="refresh">Esta página se actualiza automáticamente cada 20 segundos</p>
</body>
</html>`
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(html)
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
