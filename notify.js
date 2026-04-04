import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const CAPTA_URL = process.env.CAPTA_APP_URL || process.env.NEXT_PUBLIC_APP_URL

// Throttle: max 1 disconnect alert per line every 5 minutes (avoids spam on micro-cuts)
const disconnectAlertThrottle = new Map()
const THROTTLE_MS = 5 * 60 * 1000

export async function sendTelegramAlert(text) {
  return sendTelegram(text)
}

async function sendTelegram(text) {
  // DISABLED: Telegram alerts paused to avoid spam
  return
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
          break
        }

        const { data: { publicUrl } } = supabase.storage
          .from('comprobantes')
          .getPublicUrl(fileName)

        // Call unified Capta webhook — Claude analyzes + creates sale + fires CAPI
        await fetch(`${CAPTA_URL}/api/webhook/comprobante`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-internal-secret': process.env.INTERNAL_SECRET || '',
          },
          body: JSON.stringify({
            project_id: line.project_id,
            phone: data.phone,
            image_url: publicUrl,
            line_id: lineId,
            auto_confirm: true,
          }),
        }).then(async (res) => {
          const json = await res.json().catch(() => ({}))
          console.log(`[notify] comprobante result:`, json.status, json.extracted?.amount)
        }).catch(err => console.error('[notify] webhook/comprobante error:', err.message))

        break
      }

      case 'conversation_start': {
        const { data: csLine } = await supabase
          .from('lines')
          .select('project_id')
          .eq('id', lineId)
          .single()
        if (csLine) {
          await fetch(`${CAPTA_URL}/api/webhook/conversation`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-internal-secret': process.env.INTERNAL_SECRET || '',
            },
            body: JSON.stringify({
              project_id: csLine.project_id,
              phone: data.phone,
              line_id: lineId,
            }),
          }).catch(err => console.error('[notify] conversation_start error:', err.message))
        }
        break
      }

      case 'message': {
        // Update last_seen + name on contact
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
