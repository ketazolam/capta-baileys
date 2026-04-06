# Estado del sistema Capta/Baileys — 6 Abril 2026

## Problemas identificados (en orden de impacto)

### 🔴 P1 — Zombie state sin detección
**Qué pasa:** Cuando alguien abre WhatsApp en el celular del número conectado, Baileys
recibe error 401 "conflict" y la nueva sesión queda en estado "zombie": el WebSocket
sigue vivo (ping/pong OK), la API muestra `connected`, Supabase muestra `connected`,
pero WhatsApp no entrega ningún mensaje al bot.

**Consecuencia:** Leads que mandan comprobantes → pierden la venta, nunca se procesa
el CAPI event, Meta no recibe el Purchase.

**Fix implementado en:** `sessions.js` (zombie detection + auto-reconnect), `notify.js`
(heartbeat a Supabase + alerta Telegram), `routes/lines.js` (expone `lastMessageAt`).

---

### 🔴 P2 — 4 comprobantes perdidos el 6 de abril
**Qué pasa:** La línea estuvo zombie todo el día 6. 4 personas mandaron comprobantes,
ninguno llegó a Capta, ningún CAPI event se disparó a Meta.

**Fix:** Recuperación manual. Ver `OPS.md` → sección "Recuperar ventas manuales".

---

### 🟡 P3 — Supabase `lines.status` se vuelve stale
**Qué pasa:** `notify.js` actualiza `lines.status` solo en eventos de connect/disconnect.
Si el bot queda zombie, la tabla dice `connected` para siempre.

**Fix implementado en:** `notify.js` — heartbeat cada 5 min actualiza `last_ping_at`.
`last_message_at` se actualiza en cada comprobante/mensaje.

---

### 🟡 P4 — Alertas Telegram no funcionales
**Qué pasa:** `TELEGRAM_BOT_TOKEN` y `TELEGRAM_CHAT_ID` probablemente no están seteados
en Railway (el código tiene lógica pero no puede enviar sin las env vars).

**Fix:** Verificar/agregar estas env vars en Railway. Ver `OPS.md`.

---

### 🟢 P5 — QR expira en 60s (difícil de compartir)
**Qué pasa:** El operador necesita escanear el QR pero expira demasiado rápido para
poder mandárselo.

**Fix implementado en:** `routes/lines.js` — endpoint `/lines/:lineId/qr-page` que
sirve HTML con auto-refresh cada 20s. El operador abre esa URL en su celular y escanea.

---

## Arquitectura del flujo completo

```
Lead abre landing (ganamosmedia.com)
  → Clickea "Hablar con Roma"
  → WhatsApp del número +54 9 11 6590 7019
  → Baileys (Railway) recibe imageMessage
  → sessions.js → handleMessage → notifyCapta('comprobante')
  → notify.js sube imagen a Supabase Storage (bucket: comprobantes)
  → POST /api/webhook/comprobante a Capta (Vercel)
  → Claude Vision analiza monto + referencia + confidence
  → Si confidence=high → confirma venta + CAPI Purchase a Meta
  → Si confidence<high → sale queda pending → confirmar manual en dashboard
```

## Estado actual (post-fixes)

- [ ] QR escaneado por operador → línea reconectada
- [ ] 4 comprobantes recuperados manualmente
- [ ] Zombie detection activa en código
- [ ] Heartbeat cada 5min a Supabase
- [ ] Alerta Telegram funcionando
