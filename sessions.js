import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  Browsers,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import { AntiBan, Scheduler, ContentVariator } from 'baileys-antiban'
import path from 'path'
import fs from 'fs'
import { notifyCapta, sendTelegramAlert } from './notify.js'

const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000
const MAX_MESSAGE_AGE_SECONDS = 60 // Ignore messages older than 60s (stale on reconnect)
const recentContacts = new Map()

const SESSIONS_DIR = process.env.SESSIONS_DIR || './sessions_data'
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true })

// Map of lineId -> { socket, qr, status, phone, antiban, reconnectAttempts }
const sessions = new Map()

// Content variator: makes each outbound message technically unique (zero-width chars)
// Applied in /send endpoint so human's copy-pasted pitches are never identical
export const variator = new ContentVariator({
  zeroWidthChars: true,
  punctuationVariation: true,
  emojiPadding: false,
  synonyms: false,
})

// Scheduler: only send during realistic hours (Argentina timezone)
export const scheduler = new Scheduler({
  activeHours: [8, 23],     // 8 AM to 11 PM
  peakHours: [10, 21],      // Faster during 10-21h
  weekendFactor: 0.7,       // 30% less on weekends
  lunchBreak: [13, 14],     // Slow down at lunch
  lunchFactor: 0.5,
})

// --- Cleanup recentContacts every hour (prevent unbounded memory growth) ---
setInterval(() => {
  const now = Date.now()
  for (const [key, ts] of recentContacts) {
    if (now - ts > TWENTY_FOUR_HOURS) recentContacts.delete(key)
  }
}, 60 * 60 * 1000)

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
    // Save warm-up state before deleting
    saveWarmUpState(lineId, session?.antiban)
    sessions.delete(lineId)
    const sessionPath = path.join(SESSIONS_DIR, lineId)
    if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true })
  },
}

// Returns the warm-up day (1-based) for a line, or null if warm-up is complete
export function getWarmUpDay(antiban) {
  try {
    const state = antiban.exportWarmUpState?.()
    if (!state?.startDate) return null
    const daysSinceStart = Math.floor((Date.now() - new Date(state.startDate).getTime()) / (24 * 60 * 60 * 1000)) + 1
    // warmUpDays is 7, after that warm-up is complete
    return daysSinceStart <= 7 ? daysSinceStart : null
  } catch { return null }
}

function saveWarmUpState(lineId, antiban) {
  if (!antiban) return
  try {
    const warmUpStatePath = path.join(SESSIONS_DIR, lineId, 'warmup_state.json')
    fs.writeFileSync(warmUpStatePath, JSON.stringify(antiban.exportWarmUpState()))
  } catch {}
}

function getReconnectDelay(attempts) {
  // Exponential backoff: 5s, 10s, 20s, 40s, 80s — max 5 min
  const base = 5000
  const delay = Math.min(base * Math.pow(2, attempts), 5 * 60 * 1000)
  // Add jitter ±30%
  const jitter = delay * 0.3 * (Math.random() * 2 - 1)
  return Math.round(delay + jitter)
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
        identicalMessageWindowMs: 3600000, // re-enable: 1 hour window
      },
      warmUp: {
        warmUpDays: 7,
        day1Limit: 8,
        growthFactor: 2.0,
        inactivityThresholdHours: 72,
      },
      health: {
        autoPauseAt: 'high',
        onRiskChange: (status) => {
          console.log(`[${lineId}] Health: ${status.risk} (score: ${status.score}) — ${status.recommendation || ''}`)
          // Alert on medium/high risk escalation via Telegram
          if (status.risk === 'medium' || status.risk === 'high') {
            const emoji = status.risk === 'high' ? '🔴' : '🟡'
            sendTelegramAlert(
              `${emoji} <b>Antiban ${status.risk.toUpperCase()}</b> — línea ${lineId.slice(0, 8)}\nScore: ${status.score}\n${status.recommendation || ''}`
            )
          }
        },
      },
      logging: false,
    },
    savedWarmUpState
  )

  const sessionData = {
    status: 'connecting',
    qr: null,
    phone: null,
    socket: null,
    antiban,
    reconnectAttempts: 0,
  }
  sessions.set(lineId, sessionData)

  const sock = makeWASocket({
    version,
    auth: state,
    // Anti-fingerprint: identify as real WhatsApp Web client, not Baileys
    browser: Browsers.ubuntu('Chrome'),
    // Don't mark online immediately — avoids automated "always online" pattern
    markOnlineOnConnect: false,
    // Don't generate link previews — reduces server-side API calls
    generateHighQualityLinkPreview: false,
    printQRInTerminal: false,
    // --- Anti-detection tuning ---
    emitOwnEvents: false,           // Don't fire events for own messages (reduces noise)
    // fireInitQueries: true (default) — KEEP ON. WA servers expect init queries; skipping them is suspicious.
    retryRequestDelayMs: 500,        // Slower retries (default 250ms is too fast/bot-like)
    maxMsgRetryCount: 3,             // Fewer retries (default 5 is aggressive)
    shouldIgnoreJid: (jid) =>        // Skip system/broadcast JIDs at socket level
      jid === 'status@broadcast' || jid.endsWith('@newsletter') || jid.endsWith('@lid'),
    getMessage: async () => undefined,
    logger: (() => { const l = { level: 'silent', trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {} }; l.child = () => l; return l })(),
  })

  sessionData.socket = sock

  // Persist warm-up state every 5 minutes
  const warmUpPersistInterval = setInterval(() => saveWarmUpState(lineId, antiban), 5 * 60 * 1000)

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
      sessionData.reconnectAttempts = 0 // Reset backoff on success
      console.log(`[${lineId}] Connected as ${sessionData.phone}`)

      // Notify antiban of successful reconnection
      try { antiban.onReconnect?.() } catch {}

      await notifyCapta(lineId, 'connected', { phone: sessionData.phone })
    }

    if (connection === 'close') {
      clearInterval(warmUpPersistInterval)
      saveWarmUpState(lineId, antiban)

      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode
      console.log(`[${lineId}] Disconnected: ${reason}`)
      sessionData.status = 'disconnected'

      // Notify antiban of disconnect (feeds health monitor)
      try { antiban.onDisconnect?.(reason) } catch {}

      await notifyCapta(lineId, 'disconnected', { reason })

      const shouldReconnect = reason !== DisconnectReason.loggedOut
      if (shouldReconnect) {
        sessionData.reconnectAttempts = (sessionData.reconnectAttempts || 0) + 1

        // Cap reconnect attempts to avoid infinite loops on temp bans
        if (sessionData.reconnectAttempts > 10) {
          console.log(`[${lineId}] Max reconnect attempts reached, giving up`)
          sessions.delete(lineId)
          return
        }

        const delay = getReconnectDelay(sessionData.reconnectAttempts)
        console.log(`[${lineId}] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${sessionData.reconnectAttempts})...`)
        setTimeout(() => startSession(lineId), delay)
      } else {
        sessions.delete(lineId)
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    for (const msg of messages) {
      if (msg.key.fromMe) continue

      // --- Filter: skip stale messages delivered during reconnect ---
      const now = Math.floor(Date.now() / 1000)
      const msgTime = typeof msg.messageTimestamp === 'number'
        ? msg.messageTimestamp
        : msg.messageTimestamp?.low || 0
      if (msgTime > 0 && now - msgTime > MAX_MESSAGE_AGE_SECONDS) {
        console.log(`[${lineId}] Skipping stale message (${now - msgTime}s old)`)
        continue
      }

      await handleMessage(lineId, sock, msg)
    }
  })

  // --- Simulate human presence: go online/offline periodically ---
  const presenceInterval = setInterval(async () => {
    if (sessionData.status !== 'connected') return
    // Skip if outside active hours — go fully unavailable
    if (!scheduler.isActiveTime()) {
      try { await sock.sendPresenceUpdate('unavailable') } catch {}
      return
    }
    // 30% chance: skip this cycle entirely (humans aren't always consistent)
    if (Math.random() < 0.3) return
    try {
      await sock.sendPresenceUpdate('available')
      // Stay online for 20s–5min, then go offline
      const onlineDuration = 20000 + Math.random() * 280000
      setTimeout(async () => {
        try { await sock.sendPresenceUpdate('unavailable') } catch {}
      }, onlineDuration)
    } catch {}
  }, (15 + Math.random() * 45) * 60 * 1000) // Every 15-60 min

  // --- Simulate natural connection drops (phone sleep, network switch) ---
  // Every 3-6 hours, briefly disconnect and reconnect the WebSocket
  // This mimics WiFi→mobile handoffs and natural connection resets
  const connectionDropInterval = setInterval(async () => {
    if (sessionData.status !== 'connected') return
    // Only drop during low-activity hours (late night or random)
    const hour = new Date().getHours()
    if (hour >= 1 && hour <= 6) {
      // Night: 40% chance of a long "sleep" disconnect (30-90 min)
      if (Math.random() < 0.4) {
        console.log(`[${lineId}] Simulating night sleep disconnect`)
        try { await sock.ws.close() } catch {}
        // The reconnect handler will pick this up and reconnect after backoff
      }
    } else {
      // Day: 15% chance of a brief "network blip"
      if (Math.random() < 0.15) {
        console.log(`[${lineId}] Simulating network blip`)
        try {
          await sock.sendPresenceUpdate('unavailable')
          // Brief pause before the socket naturally reconnects
        } catch {}
      }
    }
  }, (3 + Math.random() * 3) * 60 * 60 * 1000) // Every 3-6 hours

  // Clean up intervals on disconnect
  sock.ev.on('connection.update', ({ connection }) => {
    if (connection === 'close') {
      clearInterval(presenceInterval)
      clearInterval(connectionDropInterval)
    }
  })

  return sessionData
}

async function handleMessage(lineId, sock, msg) {
  const from = msg.key.remoteJid

  // --- Filter: only handle private 1-on-1 chats ---
  if (!from || from.endsWith('@g.us') || from === 'status@broadcast' || from.endsWith('@newsletter') || from.endsWith('@lid')) {
    return
  }

  // --- Filter: skip automated/bot/system messages ---
  if (msg.message?.protocolMessage || msg.message?.reactionMessage ||
      msg.message?.pollCreationMessage || msg.message?.pollUpdateMessage ||
      msg.message?.callMessage || msg.message?.groupInviteMessage ||
      msg.message?.requestPhoneNumberMessage) {
    return
  }

  const phone = from.replace('@s.whatsapp.net', '')
  const content = msg.message

  // --- Mark message as read with human-like patterns ---
  // Not every message gets read immediately — 15% are "ignored" (read much later or never)
  const readChance = Math.random()
  if (readChance < 0.85) {
    // 85%: read within 1-8 seconds (varied, not uniform)
    const readDelay = readChance < 0.3
      ? 500 + Math.random() * 1500    // 30%: quick read (0.5-2s)
      : readChance < 0.6
        ? 2000 + Math.random() * 4000 // 30%: normal read (2-6s)
        : 5000 + Math.random() * 15000 // 25%: slow read (5-20s)
    setTimeout(async () => {
      try { await sock.readMessages([msg.key]) } catch {}
    }, readDelay)
  }
  // 15%: never marked as read (human didn't open the chat)

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
      // No auto-reply — human operator handles all outbound communication.
      // Baileys only manages: lead intake, read receipts, presence, anti-ban.
    }
  }
}

// --- Graceful shutdown: save all warm-up states ---
function gracefulShutdown(signal) {
  console.log(`[Baileys] ${signal} received, saving state...`)
  for (const [lineId, session] of sessions) {
    saveWarmUpState(lineId, session.antiban)
  }
  process.exit(0)
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))
