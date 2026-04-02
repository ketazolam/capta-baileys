import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import path from 'path'
import fs from 'fs'
import { notifyCapta } from './notify.js'
import { processComprobante } from './ocr.js'

const SESSIONS_DIR = process.env.SESSIONS_DIR || './sessions_data'
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true })

// Map of lineId -> { socket, qr, status, phone }
const sessions = new Map()

export const sessionManager = {
  count: () => sessions.size,
  get: (lineId) => sessions.get(lineId),
  getAll: () => [...sessions.entries()].map(([id, s]) => ({
    lineId: id,
    status: s.status,
    phone: s.phone,
    hasQR: !!s.qr,
  })),

  async create(lineId) {
    if (sessions.has(lineId)) return sessions.get(lineId)
    return await startSession(lineId)
  },

  async delete(lineId) {
    const session = sessions.get(lineId)
    if (session?.socket) {
      try { await session.socket.logout() } catch {}
    }
    sessions.delete(lineId)
    // Clean session files
    const sessionPath = path.join(SESSIONS_DIR, lineId)
    if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true })
  },
}

async function startSession(lineId) {
  const sessionPath = path.join(SESSIONS_DIR, lineId)
  if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true })

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath)
  const { version } = await fetchLatestBaileysVersion()

  const sessionData = { status: 'connecting', qr: null, phone: null, socket: null }
  sessions.set(lineId, sessionData)

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: { level: 'silent', trace: () => {}, debug: () => {}, info: () => {}, warn: console.warn, error: console.error, fatal: console.error, child: () => ({}) },
  })

  sessionData.socket = sock

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      sessionData.qr = qr
      sessionData.status = 'waiting_qr'
      console.log(`[${lineId}] QR ready`)
      // Notify Capta that QR is ready
      await notifyCapta(lineId, 'qr_ready', { qr })
    }

    if (connection === 'open') {
      sessionData.status = 'connected'
      sessionData.qr = null
      sessionData.phone = sock.user?.id?.split(':')[0] || null
      console.log(`[${lineId}] Connected as ${sessionData.phone}`)
      await notifyCapta(lineId, 'connected', { phone: sessionData.phone })
    }

    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode
      console.log(`[${lineId}] Disconnected: ${reason}`)
      sessionData.status = 'disconnected'
      await notifyCapta(lineId, 'disconnected', { reason })

      const shouldReconnect = reason !== DisconnectReason.loggedOut
      if (shouldReconnect) {
        console.log(`[${lineId}] Reconnecting...`)
        setTimeout(() => startSession(lineId), 3000)
      } else {
        sessions.delete(lineId)
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    for (const msg of messages) {
      if (msg.key.fromMe) continue
      await handleMessage(lineId, sock, msg)
    }
  })

  return sessionData
}

async function handleMessage(lineId, sock, msg) {
  const from = msg.key.remoteJid
  const phone = from?.replace('@s.whatsapp.net', '').replace('@g.us', '')
  const content = msg.message

  // Check for image (comprobante)
  const imageMsg = content?.imageMessage
  if (imageMsg) {
    console.log(`[${lineId}] Image received from ${phone} — processing comprobante`)
    try {
      const buffer = await sock.downloadMediaMessage(msg, 'buffer')
      const base64 = buffer.toString('base64')
      const result = await processComprobante(base64, imageMsg.mimetype || 'image/jpeg')
      if (result) {
        await notifyCapta(lineId, 'comprobante', {
          phone,
          amount: result.amount,
          reference: result.reference,
          concept: result.concept,
          imageBase64: base64,
          mimetype: imageMsg.mimetype,
        })
      }
    } catch (err) {
      console.error(`[${lineId}] Error processing comprobante:`, err.message)
    }
    return
  }

  // Text message — track as contact activity
  const text = content?.conversation || content?.extendedTextMessage?.text
  if (text) {
    await notifyCapta(lineId, 'message', { phone, text })
  }
}
