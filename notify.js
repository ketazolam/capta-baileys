import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const CAPTA_URL = process.env.CAPTA_APP_URL || process.env.NEXT_PUBLIC_APP_URL

export async function notifyCapta(lineId, event, data) {
  try {
    switch (event) {
      case 'connected':
        await supabase.from('lines').update({
          status: 'connected',
          phone_number: data.phone,
        }).eq('id', lineId)
        break

      case 'disconnected':
        await supabase.from('lines').update({
          status: 'disconnected',
          phone_number: null,
        }).eq('id', lineId)
        break

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

      case 'message':
        // Update last_seen on contact
        const { data: line } = await supabase
          .from('lines')
          .select('project_id')
          .eq('id', lineId)
          .single()
        if (line) {
          await supabase.from('contacts').upsert({
            project_id: line.project_id,
            phone: data.phone,
            last_seen_at: new Date().toISOString(),
          }, { onConflict: 'project_id,phone' })
        }
        break
    }
  } catch (err) {
    console.error(`[notify] ${event}:`, err.message)
  }
}
