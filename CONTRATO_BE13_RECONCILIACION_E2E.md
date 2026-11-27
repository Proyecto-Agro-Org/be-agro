# CONTRATO BE13 — Reconciliación end-to-end (versión consolidada)

Estado: **contrato técnico implementado en modo local/`TEST_ONLY`**. Reemplaza a `CONTRATO_BE13_11J_INGEST_CONFIRMATION.md` y a `CONTRATO_PROPUESTO_BE13_11K_PUBLISHER_RECONCILIATION_V1.md` (ambos quedan como historia; este documento manda). Los valores de política (retry, rate limit, capacidad) y la tecnología de autenticación **no están aprobados** y su default productivo es `BLOCKED`. `productionReady=false`.

Semántica: **at-least-once + procesamiento idempotente + almacenamiento durable + confirmación/reconciliación end-to-end**. No se promete exactly-once.

## 1. Niveles que no se mezclan
| Nivel | Significado |
|---|---|
| `BROKER_ACCEPTED` | el publisher recibió PUBACK. Solo eso. **No** es ingestión |
| `INGEST_DURABLE` | registro durable verificado en el Durable Inbox (`received-durable`) |
| `INGEST_CONFIRMED` | evidencia durable del backend: `processed`, `duplicate-confirmed` o `received-durable` |

## 2. Identidad y clave de reconciliación
- Clave: `(realm, sourceId, eventId)`. `sourceId` lo deriva el servidor del principal autenticado; el `eventId` lo fija el publisher y es estable entre reintentos.
- El `clientId` MQTT **es** la identidad técnica del dispositivo (el boundary rechaza `technical-identity-mismatch` si no coincide): **una conexión por identidad de publisher**; dos conexiones concurrentes con el mismo `clientId` son una colisión de identidad.
- Contenido: `payloadSha256` = SHA-256 de los bytes exactos publicados (idénticos en cada reintento); el inbox guarda `rawPayloadSha256` y `eventId` (registros nuevos).

## 3. Publicación
1. `submit`: el publisher persiste en su outbox `eventId`, `payloadSha256` y los bytes exactos. Un `eventId` reutilizado con otros bytes se **rechaza**; con los mismos bytes es idempotente.
2. Publica QoS 1. El PUBACK se registra (`brokerAcceptedCount`) y **nunca decide** el resultado.
3. Espera (backoff + jitter) y consulta la confirmación.

## 4. Consulta
`GET /ingest-confirmations/{eventId}?payloadSha256={hex64}` — router factory `TEST_ONLY` no compuesta en `app.ts`.
- Ámbito (`realm`, `sourceId`, `principalReference`) derivado del principal autenticado; ningún header/query/body lo amplía. Sin listados.
- Respuesta 200: `{ eventId, status, confirmed, evidenceVersion, deliveries, durableAt }`. Códigos: 400 entrada inválida (eventId/hash/params repetidos o con operadores), 401, 403, 414 (URL > 1024), 429 (+`Retry-After`), 503. **Solo `confirmed=true` en 200 es éxito.**
- Auth: puerto inyectado; default `BLOCKED` (no se puede componer). Rate limiting: abstracción con default `BLOCKED`; los valores de 11K son solo propuestos.
- Ajeno ≡ inexistente (`not-found`); `conflict` no revela el contenido registrado.
- Lecturas de evidencia con `readConcern: majority`, **acotadas** (4 s por defecto): sin respuesta a tiempo = `pending`.

## 5. Estados
| Estado | `confirmed` | Evidencia | Acción del publisher |
|---|---|---|---|
| `processed` | sí | claim durable + registro del inbox con el mismo hash | cerrar |
| `duplicate-confirmed` | sí | procesado y admitido ≥ 2 veces con el mismo hash | cerrar |
| `received-durable` | sí | registro durable en el inbox, aún sin claim | cerrar |
| `quarantined` | no | fila de cuarentena del ámbito (para filas nuevas: por `sourceId` o por principal autenticado + `declaredEventId` + hash) | terminal; escalar |
| `conflict` | no | mismo `eventId` con otro `payloadSha256` | terminal; error del publisher |
| `pending` | no | una fuente no respondió y no hay evidencia positiva (incluye claim sin registro de inbox que ate el hash) | reintentar |
| `not-found` | no | todas las fuentes respondieron y ninguna lo tiene (también ajeno) | reintentar |
Cualquier estado/código desconocido no confirma.

## 6. Estados del outbox del publisher
`PENDING` (lane `fast`|`slow`, phase `needs-publish`|`awaiting-confirm`) → `CONFIRMED` · `QUARANTINED` · `CONFLICT` · `UNCONFIRMED_EXPLICIT`. Carril rápido agotado ⇒ alerta `UNCONFIRMED` y carril lento; carril lento agotado ⇒ `UNCONFIRMED_EXPLICIT` (ni éxito ni pérdida declarada, retenido). Outbox lleno ⇒ `REJECTED_OUTBOX_FULL` explícito (nunca descarte silencioso). El outbox sobrevive a un crash (archivo atómico). Valores propuestos (11K): 3 s ×2, tope 60 s, ±25 %, 8 intentos, 10 min; lento 15 min hasta 24 h — **PROPOSED, no aprobados**.

## 7. Idempotencia
Una medición lógica por `(realm, sourceId, operation, eventId, field)`; re-entregas y republicaciones son idempotentes. Mismo `eventId` + mismo contenido = reintento legítimo; mismo `eventId` + otro contenido = `conflict` (confirmación), `REJECTED_EVENT_ID_REUSED_WITH_OTHER_BYTES` (outbox) y `conflict` de idempotencia (persistencia).

## 8. Observabilidad
Métricas con vocabulario cerrado (`ingest_confirmation_*`, `publisher_*`), logs por allowlist, correlación por `(sourceId, eventId)`; umbrales de alerta solo candidatos. Cross-tenant no es observable por diseño.

## 9. Límites conocidos
`received-durable` cuenta como confirmado (el registro es durable y recuperable); una confirmación sin registro de inbox (flujo sin inbox) queda `pending`; cuarentenas anteriores a 11M sin `sourceId` no son reconciliables; el rollback de código tras escribir `eventId` no es seguro (migración roll-forward).
