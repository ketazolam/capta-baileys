import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import { AntiBan } from 'baileys-antiban'
import path from 'path'
import fs from 'fs'
import { notifyCapta } from './notify.js'

const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000
const recentContacts = new Map()

const SESSIONS_DIR = process.env.SESSIONS_DIR || './sessions_data'
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true })

// Map of lineId -> { socket, qr, status, phone, antiban }
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
    const sessionPath = path.join(SESSIONS_DIR, lineId)
    if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true })
  },
}

// Pitch templates with leet speak to avoid keyword detection
const PITCH_TEMPLATES = [
  `Soy Roma❤️\nTengo para ofrecerte las dos mejores opciones del mercado!\n\nGanamos 🔮(La más buscada)\nZeus ⚡ (Original)\n\n💰Mínimo de c4rg4 $2000\n💰Mínimo de R3T1R0 $4000\n🎁 C4rgando te REGALAMOS un B0N0 de 40% 🤑💰🎁\n\nAtención personalizada las 24hs 💬\n\nDecime tu nombre o apodo y te creó tu USU4RI0`,
  `Hola! Soy Roma 💜\nTe cuento las opciones que tenemos!\n\nGanamos 🔮 (La favorita)\nZeus ⚡ (La clásica)\n\n💰 C4rga mínima: $2000\n💰 R3tir0 mínimo: $4000\n🎁 B0nus del 40% en tu primera c4rga 🤑\n\nEstoy 24/7 para ayudarte 💬\n\nPasame tu nombre y te armo el USU4RI0`,
  `Roma acá! ❤️\nMirá lo que tengo para vos:\n\nGanamos 🔮 (Top 1)\nZeus ⚡ (Original)\n\n💰 Mín. c4rg4: $2000\n💰 Mín. R3T1R0: $4000\n🎁 40% de B0N0 en la 1ra c4rga 💰🎁\n\n24hs online ✅\n\nDecime un nombre para crear tu USU4RI0`,
]

const GREETINGS = ['holii', 'holaaa', 'hola!', 'buenass', 'hey hola!']

function generatePitch() {
  return PITCH_TEMPLATES[Math.floor(Math.random() * PITCH_TEMPLATES.length)]
}

function randomDelay(min, max) {
  return new Promise(r => setTimeout(r, min + Math.random() * (max - min)))
}

async function startSession(lineId) {
  const sessionPath = path.join(SESSIONS_DIR, lineId)
  if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true })

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath)
  const { version } = await fetchLatestBaileysVersion()

  // Load warm-up state if persisted
  const warmUpStatePath = path.join(SESSIONS_DIR, lineId, 'warmup_state.json')
  let savedWarmUpState
  try {
    if (fs.existsSync(warmUpStatePath)) {
      savedWarmUpState = JSON.parse(fs.readFileSync(warmUpStatePath, 'utf8'))
    }
  } catch {}

  const antiban = new AntiBan(
    {
      rateLimiter: {
        maxPerMinute: 5,
        maxPerHour: 60,
        maxPerDay: 400,
        minDelayMs: 2000,
        maxDelayMs: 7000,
        newChatDelayMs: 4000,
        burstAllowance: 2,
        identicalMessageWindowMs: 0, // pitch is already varied
      },
      warmUp: {
        warmUpDays: 7,
        day1Limit: 15,
        growthFactor: 1.5,
        inactivityThresholdHours: 72,
      },
      health: {
        autoPauseAt: 'high',
        onRiskChange: (status) => {
          console.log(`[${lineId}] Health: ${status.risk} (score: ${status.score}) — ${status.recommendation}`)
        },
      },
      logging: false,
    },
    savedWarmUpState
  )

  const sessionData = { status: 'connecting', qr: null, phone: null, socket: null, antiban }
  sessions.set(lineId, sessionData)

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: (() => { const l = { level: 'silent', trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {} }; l.child = () => l; return l })(),
  })

  sessionData.socket = sock

  // Persist warm-up state every 5 minutes
  const warmUpPersistInterval = setInterval(() => {
    try {
      const wuState = antiban.exportWarmUpState()
      fs.writeFileSync(warmUpStatePath, JSON.stringify(wuState))
    } catch {}
  }, 5 * 60 * 1000)

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      sessionData.qr = qr
      sessionData.status = 'waiting_qr'
      console.log(`[${lineId}] QR ready`)
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
      clearInterval(warmUpPersistInterval)
      // Save warm-up state before closing
      try {
        fs.writeFileSync(warmUpStatePath, JSON.stringify(antiban.exportWarmUpState()))
      } catch {}

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
      await handleMessage(lineId, sock, antiban, msg)
    }
  })

  return sessionData
}

async function handleMessage(lineId, sock, antiban, msg) {
  const from = msg.key.remoteJid
  const phone = from?.replace('@s.whatsapp.net', '').replace('@g.us', '').replace('@lid', '')
  const content = msg.message

  // Check for image (comprobante)
  const imageMsg = content?.imageMessage
  const docMsg = content?.documentMessage
  const imageMediaMsg = imageMsg || (docMsg?.mimetype?.startsWith('image/') ? docMsg : null)
  if (imageMediaMsg) {
    console.log(`[${lineId}] Image received from ${phone} — sending to Capta`)
    try {
      const buffer = await downloadMediaMessage(msg, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage })
      const base64 = buffer.toString('base64')
      await notifyCapta(lineId, 'comprobante', {
        phone,
        imageBase64: base64,
        mimetype: imageMediaMsg.mimetype || 'image/jpeg',
      })
    } catch (err) {
      console.error(`[${lineId}] Error sending comprobante:`, err.message)
    }
    return
  }

  // Text message
  const text = content?.conversation || content?.extendedTextMessage?.text
  if (text) {
    await notifyCapta(lineId, 'message', { phone, text })

    const contactKey = `${lineId}:${phone}`
    const lastNotified = recentContacts.get(contactKey) || 0
    const isNewContact = Date.now() - lastNotified > TWENTY_FOUR_HOURS

    if (isNewContact) {
      recentContacts.set(contactKey, Date.now())
      await notifyCapta(lineId, 'conversation_start', { phone, text })

      // Auto-reply: greeting + pitch (like Convertix)
      // Delay 2-6s to simulate human reaction time
      const replyDelay = 2000 + Math.random() * 4000
      setTimeout(async () => {
        try {
          // --- Step 1: Short greeting ---
          await sock.presenceSubscribe(from)
          await sock.sendPresenceUpdate('composing', from)
          await randomDelay(800, 1800)

          const greeting = GREETINGS[Math.floor(Math.random() * GREETINGS.length)]
          const decision1 = await antiban.beforeSend(from, greeting)
          if (!decision1.allowed) {
            console.log(`[${lineId}] Antiban blocked greeting: ${decision1.reason}`)
            return
          }
          await randomDelay(decision1.delayMs, decision1.delayMs + 500)
          await sock.sendMessage(from, { text: greeting })
          antiban.afterSend(from, greeting)

          // --- Step 2: Sales pitch after human pause ---
          await randomDelay(1500, 3500)
          await sock.sendPresenceUpdate('composing', from)
          await randomDelay(2000, 4000)
          await sock.sendPresenceUpdate('paused', from)

          const pitch = generatePitch()
          const decision2 = await antiban.beforeSend(from, pitch)
          if (!decision2.allowed) {
            console.log(`[${lineId}] Antiban blocked pitch: ${decision2.reason}`)
            return
          }
          await randomDelay(decision2.delayMs, decision2.delayMs + 500)
          await sock.sendMessage(from, { text: pitch })
          antiban.afterSend(from, pitch)

          console.log(`[${lineId}] Auto-reply sent to ${phone}`)
        } catch (err) {
          console.error(`[${lineId}] Auto-reply error:`, err.message)
        }
      }, replyDelay)
    }
  }
}
