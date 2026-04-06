import { createClient } from '@supabase/supabase-js'
import fs from 'fs'
import path from 'path'

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const CAPTA_URL = process.env.CAPTA_APP_URL || process.env.NEXT_PUBLIC_APP_URL
const SESSIONS_DIR = process.env.SESSIONS_DIR || './sessions_data'
const RETRY_FILE = path.join(SESSIONS_DIR, '_webhook_retries.json')

// Throttle: max 1 disconnect alert per line every 5 minutes (avoids spam on micro-cuts)
const disconnectAlertThrottle = new Map()
const THROTTLE_MS = 5 * 60 * 1000


export async function sendTelegramAlert(text) {
  return sendTelegram(text)
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID
  if (!token || !chatId) return
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
      signal: AbortSignal.timeout(5000),
    })
  } catch {}
}

export async function notifyCapta(lineId, event, data) {
  try {
    switch (event) {
      case 'qr_ready':
        await supabase.from('lines').update({ status: 'qr_pending' }).eq('id', lineId)
        break

      case 'connected': {
        await supabase.from('lines').update({
          status: 'connected',
          phone_number: data.phone,
        }).eq('id', lineId)

        // Solo notificar si hubo una desconexion previa detectada (no en startup)
        if (disconnectAlertThrottle.has(lineId)) {
          disconnectAlertThrottle.delete(lineId) // reset para proximo ciclo
          const { data: connLine } = await supabase
            .from('lines')
            .select('name, projects(name)')
            .eq('id', lineId)
            .single()
          const lineName = connLine?.name || lineId
          const projectName = connLine?.projects?.name ? ` — proyecto <b>${connLine.projects.name}</b>` : ''
          await sendTelegram(`✅ <b>Linea reconectada${projectName}</b>\n📱 ${lineName} (+${data.phone})`)
        }
        break
      }

      case 'disconnected': {
        await supabase.from('lines').update({ status: 'disconnected' }).eq('id', lineId)

        // Throttle: skip if we already alerted for this line in the last 5 min
        const lastAlert = disconnectAlertThrottle.get(lineId) || 0
        if (Date.now() - lastAlert < THROTTLE_MS) break
        disconnectAlertThrottle.set(lineId, Date.now())

        const { data: discLine } = await supabase
          .from('lines')
          .select('name, phone_number, projects(name)')
          .eq('id', lineId)
          .single()

        const lineName = discLine?.name || lineId
        const linePhone = discLine?.phone_number ? ` (+${discLine.phone_number})` : ''
        const projectName = discLine?.projects?.name ? ` — proyecto <b>${discLine.projects.name}</b>` : ''
        // reason 401 = logged out (permanent), otherwise auto-reconnecting
        const isPermanent = data?.reason === 401
        const statusNote = isPermanent
          ? '\n🔴 Sesión cerrada — requiere escanear QR nuevamente.'
          : '\n🔄 Intentando reconectar automáticamente...'
        await sendTelegram(`⚠️ <b>Línea desconectada${projectName}</b>\n📱 ${lineName}${linePhone}${statusNote}\n\nReconectá en: ${CAPTA_URL}`)
        break
      }

      case 'zombie': {
        // Zombie detected: connected WebSocket but not receiving messages
        const { data: zombieLine } = await supabase
          .from('lines')
          .select('name, phone_number, projects(name)')
          .eq('id', lineId)
          .single()
        const lineName = zombieLine?.name || lineId.slice(0, 8)
        const linePhone = zombieLine?.phone_number ? ` (+${zombieLine.phone_number})` : ''
        const projectName = zombieLine?.projects?.name ? ` — proyecto <b>${zombieLine.projects.name}</b>` : ''
        console.error(`[notify] 🧟 Zombie alert sent for line ${lineId.slice(0, 8)}`)
        await sendTelegram(
          `🧟 <b>ZOMBIE DETECTADO${projectName}</b>\n📱 ${lineName}${linePhone}\n⚠️ ${data?.reason || 'conexión viva pero sin recibir mensajes'}\n🔄 Reconectando automáticamente...\n\nSi el problema persiste, escaneá QR nuevo en: ${CAPTA_URL}`
        )
        break
      }

      case 'comprobante': {
        const { data: line } = await supabase
          .from('lines')
          .select('project_id')
          .eq('id', lineId)
          .single()

        if (!line) break

        // Upload image to Supabase Storage
        const fileExt = data.mimetype?.includes('png') ? 'png' : 'jpg'
        const fileName = `${line.project_id}/${Date.now()}_${data.phone}.${fileExt}`
        const buffer = Buffer.from(data.imageBase64, 'base64')

        const { error: uploadErr } = await supabase.storage
          .from('comprobantes')
          .upload(fileName, buffer, {
            contentType: data.mimetype || 'image/jpeg',
            upsert: false,
          })

        if (uploadErr) {
          console.error(`[notify] Storage upload error:`, uploadErr.message)
          await sendTelegram(
            `🚨 <b>STORAGE UPLOAD FALLÓ</b>\n📱 +${data.phone}\n❌ ${uploadErr.message}\n⚠️ Comprobante perdido. Pedir al lead que reenvíe.`
          )
          break
        }

        const { data: { publicUrl } } = supabase.storage
          .from('comprobantes')
          .getPublicUrl(fileName)

        // Update last_message_at — proves bot is alive and receiving messages
        await supabase.from('lines').update({ last_message_at: new Date().toISOString() }).eq('id', lineId)

        // Call unified Capta webhook — Claude analyzes + creates sale + fires CAPI
        const webhookPayload = {
          project_id: line.project_id,
          phone: data.phone,
          image_url: publicUrl,
          line_id: lineId,
          auto_confirm: true,
        }
        const webhookHeaders = {
          'Content-Type': 'application/json',
          'x-internal-secret': process.env.INTERNAL_SECRET || '',
        }
        let webhookOk = false
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            if (attempt > 0) await new Promise(r => setTimeout(r, 5000)) // 5s retry delay
            const res = await fetch(`${CAPTA_URL}/api/webhook/comprobante`, {
              method: 'POST',
              headers: webhookHeaders,
              body: JSON.stringify(webhookPayload),
              signal: AbortSignal.timeout(25000), // 25s timeout (Vercel can cold-start)
            })
            const json = await res.json().catch(() => ({}))
            if (res.ok) {
              console.log(`[notify] comprobante result:`, json.status, json.extracted?.amount)
              webhookOk = true
              break
            }
            console.error(`[notify] webhook HTTP ${res.status}:`, json)
          } catch (err) {
            console.error(`[notify] webhook/comprobante attempt ${attempt + 1}:`, err.message)
          }
        }
        if (!webhookOk) {
          // Save to retry queue for automatic retry every 5 minutes
          saveFailedWebhook(webhookPayload, publicUrl, data.phone)
          await sendTelegram(
            `🚨 <b>WEBHOOK FALLÓ</b>\n📱 +${data.phone}\n🔗 Imagen subida: ${publicUrl}\n⚠️ Comprobante en cola de reintentos automáticos.`
          )
        }

        break
      }

      case 'conversation_start': {
        const { data: csLine } = await supabase
          .from('lines')
          .select('project_id')
          .eq('id', lineId)
          .single()
        if (csLine) {
          const convPayload = {
            project_id: csLine.project_id,
            phone: data.phone,
            line_id: lineId,
          }
          // Pass LD visit code for exact attribution (extracted from first message)
          if (data.visitCode) convPayload.visit_code = data.visitCode
          await fetch(`${CAPTA_URL}/api/webhook/conversation`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-internal-secret': process.env.INTERNAL_SECRET || '',
            },
            body: JSON.stringify(convPayload),
          }).catch(err => console.error('[notify] conversation_start error:', err.message))
        }
        break
      }

      case 'message': {
        // Update last_seen + name on contact, and last_message_at on line
        await supabase.from('lines').update({ last_message_at: new Date().toISOString() }).eq('id', lineId)
        const { data: msgLine } = await supabase
          .from('lines')
          .select('project_id')
          .eq('id', lineId)
          .single()
        if (msgLine) {
          const upsertData = {
            project_id: msgLine.project_id,
            phone: data.phone,
            last_seen_at: new Date().toISOString(),
          }
          // Save pushName as contact name (update on every message — name can change)
          if (data.pushName) upsertData.name = data.pushName
          await supabase.from('contacts').upsert(upsertData, { onConflict: 'project_id,phone' })
        }
        break
      }
    }
  } catch (err) {
    console.error(`[notify] ${event}:`, err.message)
  }
}

// --- Webhook retry queue: persist failed webhooks to disk, retry every 5 minutes ---

function saveFailedWebhook(payload, imageUrl, phone) {
  try {
    const retries = loadRetryQueue()
    retries.push({ payload, imageUrl, phone, attempts: 0, createdAt: Date.now() })
    fs.writeFileSync(RETRY_FILE, JSON.stringify(retries))
  } catch (err) {
    console.error('[notify] Failed to save webhook retry:', err.message)
  }
}

function loadRetryQueue() {
  try {
    if (fs.existsSync(RETRY_FILE)) return JSON.parse(fs.readFileSync(RETRY_FILE, 'utf8'))
  } catch {}
  return []
}

export async function processRetryQueue() {
  const retries = loadRetryQueue()
  if (!retries.length) return
  const remaining = []
  for (const entry of retries) {
    entry.attempts++
    try {
      const res = await fetch(`${CAPTA_URL}/api/webhook/comprobante`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-secret': process.env.INTERNAL_SECRET || '',
        },
        body: JSON.stringify(entry.payload),
        signal: AbortSignal.timeout(25000),
      })
      if (res.ok) {
        const json = await res.json().catch(() => ({}))
        console.log(`[retry] Webhook recovered: ${entry.phone}, sale: ${json.sale_id}`)
        await sendTelegram(`✅ <b>WEBHOOK RECUPERADO</b>\n📱 +${entry.phone}\n💰 Comprobante procesado tras ${entry.attempts} reintentos`)
        continue // remove from queue
      }
    } catch (err) {
      console.error(`[retry] Webhook retry #${entry.attempts} failed:`, err.message)
    }
    // Keep in queue if under 20 attempts (~1.5 hours of retries)
    if (entry.attempts < 20) remaining.push(entry)
    else {
      console.error(`[retry] Giving up on webhook after 20 attempts: ${entry.phone}`)
      await sendTelegram(`🔴 <b>WEBHOOK ABANDONADO</b>\n📱 +${entry.phone}\n🔗 ${entry.imageUrl}\n⚠️ 20 reintentos fallidos. Procesar manualmente.`)
    }
  }
  fs.writeFileSync(RETRY_FILE, JSON.stringify(remaining))
}
