import OpenAI from 'openai'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

export async function processComprobante(base64Image, mimetype = 'image/jpeg') {
  if (!process.env.OPENAI_API_KEY) {
    console.warn('[OCR] No OPENAI_API_KEY set, skipping comprobante processing')
    return null
  }

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Analizá este comprobante de pago o transferencia bancaria. Extraé:
1. El monto total (número, sin símbolo de moneda)
2. El número de referencia o CVU/CBU o ID de transacción
3. El concepto o descripción del pago (si hay)

Respondé SOLO con JSON en este formato exacto:
{"amount": 15000, "reference": "ABC123", "concept": "Depósito casino"}

Si no es un comprobante de pago, respondé: {"amount": null, "reference": null, "concept": null}`,
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:${mimetype};base64,${base64Image}`,
                detail: 'low',
              },
            },
          ],
        },
      ],
      max_tokens: 150,
    })

    const text = response.choices[0]?.message?.content?.trim()
    if (!text) return null

    const parsed = JSON.parse(text)
    if (!parsed.amount && !parsed.reference) return null
    return parsed
  } catch (err) {
    console.error('[OCR] Error:', err.message)
    return null
  }
}
