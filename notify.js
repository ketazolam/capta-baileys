import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const CAPTA_WEBHOOK = process.env.CAPTA_APP_URL || process.env.NEXT_PUBLIC_APP_URL

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

      case 'comprobante':
        // Get the project_id for this line
        const { data: line } = await supabase
          .from('lines')
          .select('project_id')
          .eq('id', lineId)
          .single()

        if (!line) break

        // Upsert contact
        const { data: contact } = await supabase
          .from('contacts')
          .upsert({ project_id: line.project_id, phone: data.phone }, { onConflict: 'project_id,phone' })
          .select()
          .single()

        // Save sale
        const { data: sale } = await supabase.from('sales').insert({
          project_id: line.project_id,
          contact_id: contact?.id,
          line_id: lineId,
          amount: data.amount,
          reference: data.reference,
          concept: data.concept,
          status: 'pending',
        }).select().single()

        // Note: contact totals updated atomically via increment_contact_purchase RPC
        // inside /api/webhook/sale — do NOT update here to avoid double-counting

        // Notify Capta app via webhook to send Meta CAPI Purchase event
        if (CAPTA_WEBHOOK && sale) {
          await fetch(`${CAPTA_WEBHOOK}/api/webhook/sale`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-internal-secret': process.env.INTERNAL_SECRET || '' },
            body: JSON.stringify({ saleId: sale.id, lineId, projectId: line.project_id, amount: data.amount, phone: data.phone }),
          }).catch(() => {})
        }
        break

      case 'message':
        // Update last_seen on contact
        await supabase.from('contacts').upsert({
          project_id: (await supabase.from('lines').select('project_id').eq('id', lineId).single()).data?.project_id,
          phone: data.phone,
          last_seen_at: new Date().toISOString(),
        }, { onConflict: 'project_id,phone' })
        break
    }
  } catch (err) {
    console.error(`[notify] ${event}:`, err.message)
  }
}
