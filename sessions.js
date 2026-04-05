import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  Browsers,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import { AntiBan, ContentVariator } from 'baileys-antiban'
import { HttpsProxyAgent } from 'https-proxy-agent'
import path from 'path'
import fs from 'fs'
import { notifyCapta, sendTelegramAlert } from './notify.js'

// Residential proxy — routes WhatsApp WebSocket through residential IP
// Set PROXY_URL env var: http://user:pass@host:port
// TEMPORARILY DISABLED: proxy WebSocket to WhatsApp fails (timeout/500).
// HTTP works but WS doesn't — likely IPRoyal returning datacenter IPs.
// TODO: re-enable once proxy provider is verified working for WebSocket.
const PROXY_URL = null // process.env.PROXY_URL || null
function createProxyAgent(lineId, reconnectAttempt = 0) {
  if (!PROXY_URL) return undefined
  try {
    const url = new URL(PROXY_URL)
    // IPRoyal: append session ID + lifetime for per-session sticky IP isolation
    // Each line gets its own residential IP; reconnects rotate to a fresh one
    const sessionId = lineId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16)
    const rotationSuffix = reconnectAttempt > 0 ? `r${reconnectAttempt}` : ''
    url.username = `${url.username}_session-${sessionId}${rotationSuffix}_lifetime-60m`
    return new HttpsProxyAgent(url.toString())
  } catch {
    return new HttpsProxyAgent(PROXY_URL)
  }
}

const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000
const MAX_MESSAGE_AGE_SECONDS = 300 // Ignore messages older than 5min (covers reconnect delays without losing leads)
// Tracks contacts who messaged us (lineId:phone → timestamp)
// Exported so /send can verify we're replying, not cold-outbounding
export const recentContacts = new Map()

// --- Response rate tracker: rolling 24h sent/received per line ---
// If response rate drops below 50%, it means the number is mostly sending without
// receiving — a classic spam pattern that triggers bans.
const responseRateTracker = new Map() // lineId → { sent: [{ts}], received: [{ts}] }

export function trackSent(lineId) {
  const tracker = responseRateTracker.get(lineId) || { sent: [], received: [] }
  tracker.sent.push(Date.now())
  responseRateTracker.set(lineId, tracker)
}

export function trackReceived(lineId) {
  const tracker = responseRateTracker.get(lineId) || { sent: [], received: [] }
  tracker.received.push(Date.now())
  responseRateTracker.set(lineId, tracker)
}

export function getResponseRate(lineId) {
  const tracker = responseRateTracker.get(lineId)
  if (!tracker) return { rate: 1, sent: 0, received: 0 }
  const cutoff = Date.now() - TWENTY_FOUR_HOURS
  tracker.sent = tracker.sent.filter(ts => ts > cutoff)
  tracker.received = tracker.received.filter(ts => ts > cutoff)
  responseRateTracker.set(lineId, tracker)
  const sent = tracker.sent.length
  const received = tracker.received.length
  if (sent === 0) return { rate: 1, sent, received }
  return { rate: received / sent, sent, received }
}

// Get current hour in Argentina timezone (UTC-3), works regardless of server TZ
function argentinaHour() {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).getUTCHours()
}

const SESSIONS_DIR = process.env.SESSIONS_DIR || './sessions_data'
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true })

// Map of lineId -> { socket, qr, status, phone, antiban, reconnectAttempts }
const sessions = new Map()

// Content variator: makes each outbound message slightly different
// DISABLED zeroWidthChars: WhatsApp ML can detect invisible unicode patterns
export const variator = new ContentVariator({
  zeroWidthChars: false,
  punctuationVariation: true,
  emojiPadding: false,
  synonyms: false,
})

// Active hours check using Argentina timezone (NOT Scheduler — it uses server TZ which is UTC on Railway)
export function isActiveTime() {
  const hour = argentinaHour()
  return hour >= 8 && hour < 23
}

// Sending hours — tighter window for outbound messages (avoid early morning/late night sends)
export function isSendingTime() {
  const hour = argentinaHour()
  return hour >= 10 && hour < 18 // 8h window (GREEN-API: max 8h/day sending)
}

// --- Cleanup recentContacts + responseRateTracker every hour (prevent memory growth) ---
setInterval(() => {
  const now = Date.now()
  for (const [key, ts] of recentContacts) {
    if (now - ts > TWENTY_FOUR_HOURS) recentContacts.delete(key)
  }
  // Prune old entries from response rate tracker
  const cutoff = now - TWENTY_FOUR_HOURS
  for (const [lineId, tracker] of responseRateTracker) {
    tracker.sent = tracker.sent.filter(ts => ts > cutoff)
    tracker.received = tracker.received.filter(ts => ts > cutoff)
    if (tracker.sent.length === 0 && tracker.received.length === 0) {
      responseRateTracker.delete(lineId)
    }
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
    const existing = sessions.get(lineId)
    if (existing) {
      // Connected or has QR ready — return as-is
      if (existing.status === 'connected' || existing.status === 'waiting_qr') {
        return existing
      }
      // Session is in a non-ready state (connecting, disconnected, etc.)
      // If it's been >15s without producing a QR, tear it down and restart fresh
      const age = Date.now() - (existing._createdAt || 0)
      if (age > 15000) {
        console.log(`[${lineId}] Cleaning up stale session (status: ${existing.status}, ${Math.round(age / 1000)}s old)`)
        if (existing.reconnectTimeout) clearTimeout(existing.reconnectTimeout)
        try { existing.socket?.end() } catch {}
        sessions.delete(lineId)
        // Fall through to startSession below
      } else {
        return existing // Give it more time
      }
    }
    return await startSession(lineId)
  },

  async delete(lineId) {
    const session = sessions.get(lineId)
    // Cancel any pending reconnect timeout to prevent zombie sessions
    if (session?.reconnectTimeout) clearTimeout(session.reconnectTimeout)
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
    // 10-day warm-up — GREEN-API: 10 days minimum for number survival
    return daysSinceStart <= 10 ? daysSinceStart : null
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
  // Exponential backoff: 5s → 10s → 20s → 40s → 80s → 160s → 320s → ... → max 30min
  // After 5+ failures: delays exceed 2.5 min — acts as circuit breaker
  // After 8+ failures: delays hit 30 min cap — prevents reconnect storm
  const base = 5000
  const delay = Math.min(base * Math.pow(2, attempts), 30 * 60 * 1000)
  // Add jitter ±30%
  const jitter = delay * 0.3 * (Math.random() * 2 - 1)
  return Math.round(delay + jitter)
}

async function startSession(lineId, reconnectAttemptOverride = 0, skipProxy = false) {
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
        maxPerMinute: 2,           // GREEN-API: max 1/min, 2 is compromise
        maxPerHour: 25,            // Reduce peak hourly rate
        maxPerDay: 200,            // GREEN-API consensus: max 200/day
        minDelayMs: 4000,          // More separation between messages
        maxDelayMs: 12000,         // More varied delays
        newChatDelayMs: 10000,     // Longer delay for new conversations
        burstAllowance: 1,
        identicalMessageWindowMs: 3600000,
      },
      warmUp: {
        warmUpDays: 10,            // GREEN-API: 10 days minimum
        day1Limit: 10,
        growthFactor: 1.6,         // Smooth ramp: 10→16→26→41→66→105→169→270 (capped at 200)
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

  // Create proxy agent per session — each line gets its own sticky residential IP
  // reconnectAttemptOverride is passed from the reconnect flow to rotate IP on each reconnect
  const proxyAgent = skipProxy ? undefined : createProxyAgent(lineId, reconnectAttemptOverride)
  if (skipProxy) console.log(`[${lineId}] Starting WITHOUT proxy (fallback mode)`)

  const sessionData = {
    status: 'connecting',
    qr: null,
    phone: null,
    socket: null,
    antiban,
    proxyAgent, // Store for media downloads (must route through same IP as WebSocket)
    reconnectAttempts: 0,
    simulatedDisconnect: false, // Flag to suppress Telegram alerts on intentional drops
    _createdAt: Date.now(),
  }
  sessions.set(lineId, sessionData)
  if (proxyAgent) console.log(`[${lineId}] Using residential proxy (session: ${lineId.slice(0, 8)}${reconnectAttemptOverride > 0 ? `/r${reconnectAttemptOverride}` : ''})`)

  const sock = makeWASocket({
    version,
    auth: state,
    // --- Residential proxy: route WebSocket + fetches through residential IP ---
    agent: proxyAgent,
    fetchAgent: proxyAgent,
    // Anti-fingerprint: Windows + Chrome is the most common combo in Argentina
    browser: Browsers.windows('Chrome'),
    // Locale must match phone number country (+54) and proxy geolocation (AR)
    countryCode: 'AR',
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
    // WebSocket upgrade headers — match a real Chrome browser in Argentina
    options: {
      headers: {
        'Accept-Language': 'es-AR,es;q=0.9,en;q=0.8',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
      },
    },
    logger: (() => {
      const l = {
        level: 'error',
        trace: () => {}, debug: () => {}, info: () => {},
        warn: (...args) => console.log(`[${lineId}][WA-warn]`, ...args),
        error: (...args) => console.error(`[${lineId}][WA-error]`, ...args),
        fatal: (...args) => console.error(`[${lineId}][WA-fatal]`, ...args),
      }
      l.child = () => l
      return l
    })(),
  })

  sessionData.socket = sock

  // Connection timeout: if no QR and no connection after 20s, retry without proxy
  if (proxyAgent) {
    sessionData._connectTimeout = setTimeout(() => {
      if (sessionData.status === 'connecting' && !sessionData.qr) {
        console.log(`[${lineId}] Connection timeout with proxy — retrying WITHOUT proxy`)
        try { sock.end() } catch {}
        sessions.delete(lineId)
        startSession(lineId, reconnectAttemptOverride, true)
      }
    }, 20000)
  }

  // Clear connection timeout once QR or connection is established
  sock.ev.on('connection.update', ({ connection, qr: qrCode }) => {
    if ((qrCode || connection === 'open') && sessionData._connectTimeout) {
      clearTimeout(sessionData._connectTimeout)
      sessionData._connectTimeout = null
    }
  })

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
      const errorMsg = lastDisconnect?.error?.message || lastDisconnect?.error || 'unknown'
      console.log(`[${lineId}] Connection closed: reason=${reason}, error=${errorMsg}`)
      sessionData.status = 'disconnected'

      // Skip alerts for intentional simulated disconnects
      if (sessionData.simulatedDisconnect) {
        sessionData.simulatedDisconnect = false
        console.log(`[${lineId}] Simulated disconnect (no alert), reconnecting...`)
      } else {
        console.log(`[${lineId}] Disconnected: ${reason}`)
        // Log critical error codes that signal impending ban
        if (reason === 403) console.error(`[${lineId}] ⚠️ 403 FORBIDDEN — account may be flagged`)
        if (reason === 463) console.error(`[${lineId}] ⚠️ 463 REACH-OUT TIMELOCK — too many messages to unknown contacts`)
        // Notify antiban of disconnect (feeds health monitor)
        try { antiban.onDisconnect?.(reason) } catch {}
        await notifyCapta(lineId, 'disconnected', { reason })
      }

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
        const attempts = sessionData.reconnectAttempts
        sessionData.reconnectTimeout = setTimeout(() => startSession(lineId, attempts), delay)
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

      // Track incoming message for response rate monitoring
      trackReceived(lineId)

      await handleMessage(lineId, sock, msg, sessionData.proxyAgent)
    }
  })

  // --- Simulate human presence: go online/offline with VARIABLE intervals ---
  // Fixed setInterval is a fingerprint — real humans are never periodic.
  // Use recursive setTimeout so each cycle has a different delay.
  let presenceTimer = null
  function schedulePresenceCycle() {
    const nextDelay = (15 + Math.random() * 45) * 60 * 1000 // 15-60 min, different each time
    presenceTimer = setTimeout(async () => {
      if (sessionData.status !== 'connected') { schedulePresenceCycle(); return }
      if (!isActiveTime()) {
        try { await sock.sendPresenceUpdate('unavailable') } catch {}
        schedulePresenceCycle(); return
      }
      // 30% chance: skip this cycle entirely (humans aren't always consistent)
      if (Math.random() < 0.3) { schedulePresenceCycle(); return }
      try {
        await sock.sendPresenceUpdate('available')
        const onlineDuration = 20000 + Math.random() * 280000 // 20s–5min
        setTimeout(async () => {
          try { await sock.sendPresenceUpdate('unavailable') } catch {}
        }, onlineDuration)
      } catch {}
      schedulePresenceCycle()
    }, nextDelay)
  }
  schedulePresenceCycle()

  // --- Simulate natural connection drops (phone sleep, network switch) ---
  // Variable interval (not fixed setInterval) — real devices aren't periodic
  let connectionDropTimer = null
  function scheduleConnectionDrop() {
    const nextDelay = (3 + Math.random() * 3) * 60 * 60 * 1000 // 3-6 hours, different each time
    connectionDropTimer = setTimeout(async () => {
      if (sessionData.status !== 'connected') { scheduleConnectionDrop(); return }
      const hour = argentinaHour()
      if (hour >= 1 && hour <= 6) {
        // Night: 40% chance of a long "sleep" disconnect
        if (Math.random() < 0.4) {
          console.log(`[${lineId}] Simulating night sleep disconnect`)
          sessionData.simulatedDisconnect = true
          try { sock.end(new Boom('Simulated sleep', { statusCode: DisconnectReason.connectionLost })) } catch {}
          return // Don't reschedule — reconnect flow will create new session
        }
      } else {
        // Day: 15% chance of a brief "network blip"
        if (Math.random() < 0.15) {
          console.log(`[${lineId}] Simulating network blip`)
          try { await sock.sendPresenceUpdate('unavailable') } catch {}
        }
      }
      scheduleConnectionDrop()
    }, nextDelay)
  }
  scheduleConnectionDrop()

  // --- Self-chat outbound seeding: add outbound traffic to look like a real user ---
  // A number that only receives and never sends is statistically anomalous.
  // Send to self-chat (own JID) — completely safe, no external recipient.
  // Variable interval (not fixed setInterval) — same pattern as presence/connection drops.
  const selfChatMessages = ['\u{1f4cc}', '\u{2705}', '\u{1f44d}', '\u{1f517}', 'ok', '..', 'listo', 'ver']
  let selfChatTimer = null
  function scheduleSelfChat() {
    const nextDelay = (1.5 + Math.random() * 4.5) * 60 * 60 * 1000 // 1.5-6 hours, different each time
    selfChatTimer = setTimeout(async () => {
      if (sessionData.status !== 'connected' || !isSendingTime()) { scheduleSelfChat(); return }
      if (Math.random() > 0.3) { scheduleSelfChat(); return } // ~30% chance = ~2-3 per day
      if (!sessionData.phone) { scheduleSelfChat(); return }
      try {
        const selfJid = `${sessionData.phone}@s.whatsapp.net`
        const selfMsg = selfChatMessages[Math.floor(Math.random() * selfChatMessages.length)]
        await sock.sendMessage(selfJid, { text: selfMsg })
      } catch {}
      scheduleSelfChat()
    }, nextDelay)
  }
  scheduleSelfChat()

  // Clean up timers on disconnect
  sock.ev.on('connection.update', ({ connection }) => {
    if (connection === 'close') {
      clearTimeout(presenceTimer)
      clearTimeout(connectionDropTimer)
      clearTimeout(selfChatTimer)
    }
  })

  return sessionData
}

async function handleMessage(lineId, sock, msg, proxyAgent) {
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
  const pushName = msg.pushName || null // WhatsApp display name of the sender

  // --- Filter: skip invalid phone numbers (LIDs, internal IDs) ---
  // Real phone numbers are 7-15 digits. WhatsApp LIDs are 15+ digit internal IDs.
  if (phone.length > 15 || phone.length < 7 || phone.includes('@')) {
    return
  }
  const content = msg.message

  // Register contact as "messaged us" for ALL message types (text, image, audio, etc.)
  // Critical: without this, image-first leads can't be replied to during warm-up
  const contactKey = `${lineId}:${phone}`
  const lastNotified = recentContacts.get(contactKey) || 0
  const isNewContact = Date.now() - lastNotified > TWENTY_FOUR_HOURS
  recentContacts.set(contactKey, Date.now())

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
    // Fire conversation_start for image-first leads (analytics funnel)
    if (isNewContact) {
      await notifyCapta(lineId, 'conversation_start', { phone, text: '[imagen]', pushName })
    }
    try {
      const dlOpts = proxyAgent ? { options: { httpsAgent: proxyAgent, httpAgent: proxyAgent } } : {}
      const buffer = await downloadMediaMessage(msg, 'buffer', dlOpts, { reuploadRequest: sock.updateMediaMessage })
      const base64 = buffer.toString('base64')
      await notifyCapta(lineId, 'comprobante', {
        phone,
        pushName,
        imageBase64: base64,
        mimetype: imageMediaMsg.mimetype || 'image/jpeg',
      })
    } catch (err) {
      console.error(`[${lineId}] Error sending comprobante:`, err.message)
    }
    return
  }

  // --- Silent media download: mimic real WhatsApp Web behavior ---
  // Real clients auto-download media. Download + discard to match server-side patterns.
  const otherMedia = content?.audioMessage || content?.videoMessage ||
                     content?.stickerMessage || content?.documentMessage
  if (otherMedia) {
    if (Math.random() < 0.8) { // 80% download, 20% skip (human sometimes ignores)
      const dlDelay = 2000 + Math.random() * 13000 // 2-15s delay
      setTimeout(async () => {
        try {
          const dlOpts = proxyAgent ? { options: { httpsAgent: proxyAgent, httpAgent: proxyAgent } } : {}
          await downloadMediaMessage(msg, 'buffer', dlOpts, { reuploadRequest: sock.updateMediaMessage })
        } catch {} // Silent fail — non-critical
      }, dlDelay)
    }
    // Don't process further — no text to handle
    return
  }

  // Text message
  const text = content?.conversation || content?.extendedTextMessage?.text
  if (text) {
    await notifyCapta(lineId, 'message', { phone, text, pushName })

    if (isNewContact) {
      await notifyCapta(lineId, 'conversation_start', { phone, text, pushName })
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
