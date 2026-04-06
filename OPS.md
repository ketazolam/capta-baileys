# Protocolo Operacional — Capta/Baileys

## Regla #1 — NUNCA abrir WhatsApp en el celular del número conectado

El número `+54 9 11 6590 7019` (u otro número conectado al bot) NO puede usarse
simultáneamente en:
- WhatsApp en el celular físico
- WhatsApp Web en un navegador
- Cualquier otra sesión de Baileys

Si se abre WhatsApp en el celular, el bot recibe error 401 "conflict" y queda en
estado zombie (conectado pero sin recibir mensajes). **El bot se auto-reconecta
con nuevo QR automáticamente**, pero el operador debe escanear el QR nuevo.

---

## Cómo escanear el QR (cuando el bot pide reconexión)

1. Abrir en el navegador:
   ```
   https://baileys-server-production-98e1.up.railway.app/lines/[LINE_ID]/qr-page
   ```
   (con el header `x-internal-secret` — usar la URL del panel de Capta en su lugar)

2. **Mejor opción:** abrir el panel de Capta → Proyecto → Líneas → aparece el QR
   con auto-refresh.

3. Desde el celular del número: WhatsApp → ⋮ → Dispositivos vinculados → Vincular.

---

## Cómo recuperar ventas perdidas manualmente

Cuando un lead mandó un comprobante pero no apareció en el dashboard:

### Lo que necesitás del lead:
- La imagen del comprobante (pedísela por Telegram, mail, o reenviada por WA)
- Su número de teléfono (con código de país, ej: `549XXXXXXXXXX`)

### El script de recuperación:

```bash
# 1. Subir imagen a Supabase Storage
SUPABASE_URL="https://tisydoofuojzminqybsy.supabase.co"
SUPABASE_KEY="[SERVICE_ROLE_KEY]"
PROJECT_ID="[UUID del proyecto en Capta]"
PHONE="549XXXXXXXXXX"
FILE_PATH="/ruta/a/comprobante.jpg"

# Subir
FILENAME="${PROJECT_ID}/manual_$(date +%s)_${PHONE}.jpg"
curl -s -X POST "${SUPABASE_URL}/storage/v1/object/comprobantes/${FILENAME}" \
  -H "Authorization: Bearer ${SUPABASE_KEY}" \
  -H "Content-Type: image/jpeg" \
  --data-binary "@${FILE_PATH}"

# URL pública
IMAGE_URL="${SUPABASE_URL}/storage/v1/object/public/comprobantes/${FILENAME}"

# 2. Llamar al webhook de Capta
curl -X POST "https://capta-eight.vercel.app/api/webhook/comprobante" \
  -H "x-internal-secret: ef359f6fb6cfb844264ee150e53c9fb149e8c154ed5602f394b68a1dce08c96e" \
  -H "Content-Type: application/json" \
  -d "{
    \"project_id\": \"${PROJECT_ID}\",
    \"phone\": \"${PHONE}\",
    \"image_url\": \"${IMAGE_URL}\",
    \"line_id\": \"b096e581-fb87-47c5-8ae9-da11cfc05688\",
    \"auto_confirm\": true
  }"
```

### Verificar en Meta Events Manager:
Después de procesar cada comprobante, verificar que aparezca un evento `Purchase`
en Events Manager dentro de los 20 minutos siguientes.

---

## Señales de alerta a monitorear

| Señal | Significado | Acción |
|---|---|---|
| `🧟 ZOMBIE DETECTED` en Railway logs | Bot conectado pero sordo | Auto-reconecta — verificar QR en panel |
| `401 conflict` en Railway logs | Alguien abrió WA en el celular | Escanear QR nuevo |
| `last_message_at > 4hs` en horario activo | Posible zombie o ausencia de leads | Revisar ads, verificar bot |
| Health responde `ok: false` | Servidor caído | Revisar Railway, redeployar |
| Alerta Telegram "Línea desconectada" | Desconexión detectada | Escanear QR |

---

## Variables de entorno necesarias en Railway

```
CAPTA_APP_URL=https://capta-eight.vercel.app
INTERNAL_SECRET=ef359f6fb6cfb844264ee150e53c9fb149e8c154ed5602f394b68a1dce08c96e
NEXT_PUBLIC_SUPABASE_URL=https://tisydoofuojzminqybsy.supabase.co
SUPABASE_SERVICE_ROLE_KEY=[key]
SESSIONS_DIR=./sessions_data
PORT=3001
TELEGRAM_BOT_TOKEN=[bot_token]   ← verificar que esté seteado
TELEGRAM_CHAT_ID=[chat_id]       ← verificar que esté seteado
```
