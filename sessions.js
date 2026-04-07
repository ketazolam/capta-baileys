import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  Browsers,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import { AntiBan } from 'baileys-antiban'
import { HttpsProxyAgent } from 'https-proxy-agent'
import path from 'path'
import fs from 'fs'
import { createClient } from '@supabase/supabase-js'
import { notifyCapta, sendTelegramAlert } from './notify.js'

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

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
const MAX_MESSAGE_AGE_SECONDS = 600 // Ignore messages older than 10min — 5min was too aggressive, losing msgs during reconnects
// Tracks contacts who messaged us (lineId:phone → timestamp)
export const recentContacts = new Map()

// Clean up recentContacts every hour — removes entries older than 25h to prevent memory growth
setInterval(() => {
  const cutoff = Date.now() - TWENTY_FOUR_HOURS - 60 * 60 * 1000
  for (const [key, ts] of recentContacts) {
    if (ts < cutoff) recentContacts.delete(key)
  }
}, 60 * 60 * 1000)

// Get current hour in Argentina timezone (UTC-3), works regardless of server TZ
function argentinaHour() {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).getUTCHours()
}

const SESSIONS_DIR = process.env.SESSIONS_DIR || './sessions_data'
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true })

// Map of lineId -> { socket, qr, status, phone, antiban, reconnectAttempts }
const sessions = new Map()

// Active hours check using Argentina timezone (NOT Scheduler — it uses server TZ which is UTC on Railway)
export function isActiveTime() {
  const hour = argentinaHour()
  return hour >= 8 && hour < 23
}


export const sessionManager = {
  count: () => sessions.size,
  get: (lineId) => sessions.get(lineId),
  getAll: () => [...sessions.entries()].map(([id, s]) => {
    const connectedMs = s.connectedAt ? Date.now() - s.connectedAt : null
    const lastMsgMs = s.lastMessageAt ? Date.now() - s.lastMessageAt : null
    const zombieThresholdMs = isActiveTime() ? 2 * 60 * 60 * 1000 : 5 * 60 * 60 * 1000
    const neverReceived = s.status === 'connected' && !s.lastMessageAt && connectedMs > zombieThresholdMs
    const longSilence = s.status === 'connected' && lastMsgMs !== null && lastMsgMs > zombieThresholdMs
    return {
      lineId: id,
      status: s.status,
      phone: s.phone,
      hasQR: !!s.qr,
      lastMessageAt: s.lastMessageAt ? new Date(s.lastMessageAt).toISOString() : null,
      connectedAt: s.connectedAt ? new Date(s.connectedAt).toISOString() : null,
      zombieSuspected: neverReceived || longSilence,
    }
  }),

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
    // Cancel all timers to prevent leaks
    if (session?.reconnectTimeout) clearTimeout(session.reconnectTimeout)
    if (session?._zombieTimer) clearInterval(session._zombieTimer)
    if (session?._warmUpPersistInterval) clearInterval(session._warmUpPersistInterval)
    if (session?._connectTimeout) clearTimeout(session._connectTimeout)
    if (session?._presenceTimer) clearTimeout(session._presenceTimer)
    if (session?._connectionDropTimer) clearTimeout(session._connectionDropTimer)
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
        maxPerMinute: 10,          // Inbound-only: replies only, relaxed limits
        maxPerHour: 100,
        maxPerDay: 1000,
        minDelayMs: 1000,
        maxDelayMs: 3000,
        newChatDelayMs: 2000,
        burstAllowance: 5,
        identicalMessageWindowMs: 60000,
      },
      warmUp: {
        warmUpDays: 1,             // Inbound-only: no real warm-up needed
        day1Limit: 1000,
        growthFactor: 1,
        inactivityThresholdHours: 720,
      },
      health: {
        autoPauseAt: 'none',  // Inbound-only: never auto-pause replies
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
    connectedAt: null,       // When the session last became connected
    lastMessageAt: null,     // When the last real inbound message was received
    _zombieTimer: null,      // Timer for zombie detection checks
    _warmUpPersistInterval: null,
    _presenceTimer: null,
    _connectionDropTimer: null,
  }
  sessions.set(lineId, sessionData)

  // Pre-load project_id with retry — critical for contact creation reliability
  ;(async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { data: ld, error: ldErr } = await Promise.race([
          supabase.from('lines').select('project_id').eq('id', lineId).single(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
        ])
        if (ldErr) throw ldErr
        if (ld?.project_id) {
          sessionData._projectId = ld.project_id
          console.log(`[${lineId}] project_id pre-loaded: ${ld.project_id.slice(0, 8)}`)
          return
        }
        console.warn(`[${lineId}] Line has no project_id in Supabase — contacts won't be created`)
        return
      } catch (err) {
        console.warn(`[${lineId}] project_id preload attempt ${attempt + 1}/3 failed: ${err.message}`)
        if (attempt < 2) await new Promise(r => setTimeout(r, 3000))
      }
    }
    console.error(`[${lineId}] project_id preload failed after 3 attempts — contacts may be lost`)
  })()

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
  if (sessionData._warmUpPersistInterval) clearInterval(sessionData._warmUpPersistInterval)
  sessionData._warmUpPersistInterval = setInterval(() => saveWarmUpState(lineId, antiban), 5 * 60 * 1000)

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
      sessionData.connectedAt = Date.now()
      // Preserve lastMessageAt across simulated reconnects to avoid false zombie alerts.
      // Only reset on truly fresh connections (first connect or after 401 loggedOut).
      if (!sessionData.lastMessageAt) sessionData.lastMessageAt = null
      console.log(`[${lineId}] Connected as ${sessionData.phone}`)

      // Notify antiban of successful reconnection
      try { antiban.onReconnect?.() } catch {}

      await notifyCapta(lineId, 'connected', { phone: sessionData.phone })

      // --- Zombie detection: check every 30min if we're connected but receiving nothing ---
      // A zombie session has WS alive but WA stopped delivering messages (usually after 401 conflict)
      // ALWAYS reconnect on zombie — even at night. Only suppress Telegram alert outside active hours.
      if (sessionData._zombieTimer) clearInterval(sessionData._zombieTimer)
      sessionData._zombieTimer = setInterval(async () => {
        if (sessionData.status !== 'connected') return
        if (!sessions.has(lineId)) { clearInterval(sessionData._zombieTimer); sessionData._zombieTimer = null; return }
        const connectedMs = Date.now() - (sessionData.connectedAt || Date.now())
        const lastMsgMs = sessionData.lastMessageAt ? Date.now() - sessionData.lastMessageAt : connectedMs
        // Use a longer threshold at night to avoid false positives during low-traffic hours.
        // During active hours (8-23): 2h threshold catches genuine zombies quickly.
        // During night (23-8): 5h threshold avoids reconnects just because no one messaged at 1 AM.
        // Genuine zombies at night are still caught — just with a ~5h delay instead of 2h.
        const zombieThresholdMs = isActiveTime() ? 2 * 60 * 60 * 1000 : 5 * 60 * 60 * 1000
        const neverReceived = !sessionData.lastMessageAt && connectedMs > zombieThresholdMs
        const longSilence = sessionData.lastMessageAt && lastMsgMs > zombieThresholdMs
        if (neverReceived || longSilence) {
          const reason = neverReceived
            ? `conectado hace ${Math.round(connectedMs / 60000)}min sin recibir ningún mensaje`
            : `último mensaje hace ${Math.round(lastMsgMs / 3600000)}h`
          console.error(`[${lineId}] 🧟 ZOMBIE DETECTED — ${reason}. Forzando reconexión.`)
          // Only send Telegram alert during active hours — silence at night is expected but still reconnect
          if (isActiveTime()) await notifyCapta(lineId, 'zombie', { reason })
          clearInterval(sessionData._zombieTimer)
          sessionData._zombieTimer = null
          try { sock.end() } catch {} // triggers normal reconnect flow
        }
      }, 15 * 60 * 1000) // check every 15 minutes
    }

    if (connection === 'close') {
      if (sessionData._warmUpPersistInterval) { clearInterval(sessionData._warmUpPersistInterval); sessionData._warmUpPersistInterval = null }
      if (sessionData._zombieTimer) { clearInterval(sessionData._zombieTimer); sessionData._zombieTimer = null }
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

      if (reason === DisconnectReason.loggedOut) {
        // 401 = session invalidated (someone opened WA on phone, or device revoked).
        // Clear auth files so next session generates a fresh QR.
        const sessionPath = path.join(SESSIONS_DIR, lineId)
        try { if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true }) } catch {}
        sessions.delete(lineId)
        console.log(`[${lineId}] Auth cleared after 401 — starting fresh session with new QR`)
        // Auto-restart: generate new QR immediately instead of staying dead
        // But skip if the line was deactivated in Supabase (avoids phantom QR generation)
        setTimeout(async () => {
          try {
            const { data: line } = await supabase.from('lines').select('is_active').eq('id', lineId).single()
            if (line?.is_active === false) {
              console.log(`[${lineId}] Line inactive in Supabase — skipping auto-restart after 401`)
              return
            }
            await sessionManager.create(lineId)
          } catch (err) {
            console.error(`[${lineId}] Failed to auto-restart after 401:`, err.message)
          }
        }, 5000)
      } else {
        // 408 = QR timeout (user didn't scan) — not a real connection error, don't count it
        if (reason !== 408) {
          sessionData.reconnectAttempts = (sessionData.reconnectAttempts || 0) + 1
        }

        // Cap reconnect attempts to avoid infinite loops on temp bans
        if (sessionData.reconnectAttempts > 10) {
          console.log(`[${lineId}] Max reconnect attempts reached, giving up`)
          const CAPTA_URL = process.env.CAPTA_APP_URL || process.env.NEXT_PUBLIC_APP_URL || ''
          await sendTelegramAlert(
            `🔴 <b>LÍNEA MUERTA</b>\n📱 Línea ${lineId.slice(0, 8)}\n⚠️ 10 reconexiones fallidas. Sesión eliminada.\n🔗 Reconectar en: ${CAPTA_URL}`
          )
          sessions.delete(lineId)
          return
        }

        const delay = getReconnectDelay(sessionData.reconnectAttempts)
        console.log(`[${lineId}] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${sessionData.reconnectAttempts})...`)
        const attempts = sessionData.reconnectAttempts
        sessionData.reconnectTimeout = setTimeout(() => startSession(lineId, attempts), delay)
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

      // Track last real message received — used by zombie detection
      sessionData.lastMessageAt = Date.now()

      try {
        await handleMessage(lineId, sock, msg, sessionData.proxyAgent)
      } catch (err) {
        console.error(`[${lineId}] handleMessage error (msg skipped):`, err.message)
      }
    }
  })

  // --- Simulate human presence: go online/offline with VARIABLE intervals ---
  // Fixed setInterval is a fingerprint — real humans are never periodic.
  // Use recursive setTimeout so each cycle has a different delay.
  function schedulePresenceCycle() {
    const nextDelay = (15 + Math.random() * 45) * 60 * 1000 // 15-60 min, different each time
    sessionData._presenceTimer = setTimeout(async () => {
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
  function scheduleConnectionDrop() {
    const nextDelay = (3 + Math.random() * 3) * 60 * 60 * 1000 // 3-6 hours, different each time
    sessionData._connectionDropTimer = setTimeout(async () => {
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

  // Clean up timers on disconnect
  sock.ev.on('connection.update', ({ connection }) => {
    if (connection === 'close') {
      if (sessionData._presenceTimer) { clearTimeout(sessionData._presenceTimer); sessionData._presenceTimer = null }
      if (sessionData._connectionDropTimer) { clearTimeout(sessionData._connectionDropTimer); sessionData._connectionDropTimer = null }
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

  // Direct contact upsert — Railway → Supabase for ALL message types
  // Avoids the fragile HTTP → Vercel chain (cold starts, timeouts) that was losing contacts
  const sessionData = sessions.get(lineId)
  if (sessionData && !sessionData._projectId) {
    try {
      const { data: ld } = await Promise.race([
        supabase.from('lines').select('project_id').eq('id', lineId).single(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
      ])
      sessionData._projectId = ld?.project_id || null
    } catch (err) {
      console.warn(`[${lineId}] Lazy project_id load failed: ${err.message}`)
    }
  }
  if (sessionData?._projectId) {
    const upsertData = { project_id: sessionData._projectId, phone, last_seen_at: new Date().toISOString() }
    if (pushName) upsertData.name = pushName
    const { error: upsertErr } = await supabase.from('contacts').upsert(upsertData, { onConflict: 'project_id,phone' })
    if (upsertErr) console.error(`[${lineId}] Contact upsert error:`, upsertErr.message)
  }

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
      // Retry once on failure (covers transient network issues)
      let buffer
      for (let dlAttempt = 0; dlAttempt < 2; dlAttempt++) {
        try {
          if (dlAttempt > 0) await new Promise(r => setTimeout(r, 5000))
          buffer = await Promise.race([
            downloadMediaMessage(msg, 'buffer', dlOpts, { reuploadRequest: sock.updateMediaMessage }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Media download timeout (30s)')), 30000)),
          ])
          break
        } catch (dlErr) {
          if (dlAttempt === 0) { console.warn(`[${lineId}] Media download attempt 1 failed: ${dlErr.message}, retrying in 5s...`); continue }
          throw dlErr
        }
      }
      const base64 = buffer.toString('base64')
      await notifyCapta(lineId, 'comprobante', {
        phone,
        pushName,
        imageBase64: base64,
        mimetype: imageMediaMsg.mimetype || 'image/jpeg',
      })
    } catch (err) {
      console.error(`[${lineId}] Error sending comprobante:`, err.message)
      // CRITICAL: alert on lost comprobante — this is a missed conversion
      sendTelegramAlert(
        `🚨 <b>COMPROBANTE PERDIDO</b>\n📱 +${phone}\n❌ ${err.message}\n⚠️ Pedir al lead que reenvíe la imagen`
      ).catch(() => {})
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
    // Extract LD code (visit code) from first message — enables exact attribution
    // Format: LD_XXXXXXXX (8 uppercase alphanumeric chars from sessionId)
    const ldMatch = text.match(/LD_([A-Z0-9_-]{6,10})/i)
    const visitCode = ldMatch ? ldMatch[1].toUpperCase() : null

    await notifyCapta(lineId, 'message', { phone, text, pushName })

    if (isNewContact) {
      await notifyCapta(lineId, 'conversation_start', { phone, text, pushName, visitCode })
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
