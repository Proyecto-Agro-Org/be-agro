# ADR BE13-11J — Confirmación end-to-end por reconciliación del publisher (prototipo)

Estado: `PROPUESTO / PROTOTIPO_LOCAL`. No es una decisión productiva (fila 72 sigue `PENDIENTE`). `productionReady=false`.

## Contexto
F-E2 (`BLOCKED_BY_BROKER_CAPABILITY`) y BE13-11I (`SESSION_STATE_LOSS_LOCAL`) demostraron que un evento con PUBACK puede no llegar nunca al backend tras un restart con historial de sesión, sin que el broker lo señale. Intentar hacer confiable el PUBACK queda fuera de alcance.

## Decisión del prototipo
1. Separar `BROKER_ACCEPTED` ≠ `INGEST_CONFIRMED`. El éxito solo existe con evidencia durable del backend.
2. Semántica: **at-least-once + procesamiento idempotente + confirmación/reconciliación end-to-end**. No se afirma exactly-once.
3. Canal elegido para el prototipo: **HTTP de reconciliación** (consulta por `eventId`).
4. El publisher reintenta con el **mismo `eventId`**, de forma acotada; al agotar el presupuesto el evento queda `UNCONFIRMED_EXPLICIT`.

## Alternativas
| | A. HTTP por `eventId` (elegida) | B. Topic MQTT de confirmación |
|---|---|---|
| depende de otra sesión MQTT durable | no | **sí** (la confirmación viajaría por el mismo mecanismo que falló: circularidad con F-E2) |
| auth y realm | reutiliza el modelo de scope por principal | exige ACL de topics por tenant y emisión por evento |
| consulta explícita | sí, a demanda y repetible | no: es un push que puede perderse y habría que reconciliar de nuevo |
| complejidad | un `GET` solo lectura sobre evidencia existente | publicar un ack por evento + manejar su entrega/expiración |
B se documenta como alternativa; no se implementó. La preferencia por A **no** es decisión productiva.

## Evidencia usada (solo lectura, majority)
claim idempotente (`processed`), registro del Durable Inbox (`received-durable`), cuarentena (`quarantined`). Dos o más registros del inbox + claim ⇒ `duplicate-confirmed`.

## Consecuencias y límites conocidos
- El Durable Inbox **no tiene columna `eventId`**: la consulta es un escaneo acotado (5 000 registros recientes del `sourceId`) que parsea el `eventId` del payload crudo. Para producción hace falta un `eventId` indexado en el inbox (decisión humana pendiente, no tomada). Una omisión por límite del escaneo degrada a `not-found`/reintento, nunca a éxito.
- Las filas de cuarentena sin `sourceId` no son atribuibles a un tenant y no se muestran: el publisher recibirá `not-found` y agotará el presupuesto (`UNCONFIRMED_EXPLICIT`).
- `received-durable` cuenta como confirmado porque el registro es durable y el reconciliador del backend lo procesa; si luego terminara en cuarentena, queda a cargo del backend/operaciones.
- Un `eventId` reutilizado con otro contenido no es distinguible por una consulta solo-`eventId`.
- Hacen falta, antes de cualquier uso real: política de retry aprobada, autenticación real de publishers HTTP (hoy un `authenticate` inyectado), rate limiting de la consulta, retención del inbox y límite de ventana del escaneo.

## Fuera de alcance
Cambiar broker/versión, reinterpretar PUBACK, garantizar exactly-once, habilitar en Production.
