# CONTRATO — Outbox del publisher (BE14-01, `REFERENCE_IMPLEMENTATION_ONLY`)

Deriva de `CONTRATO_BE13_RECONCILIACION_E2E.md` (canónico) y no lo modifica. Valores de política **no aprobados**; defaults productivos `BLOCKED`.

## Registro del outbox
`eventId`, `payloadSha256`, `payloadB64` (bytes exactos), `createdAt`, `publishAttempts`, `reconciliationAttempts`, `lastPublishAt`, `lastReconciliationAt`, `nextAttemptAt`, `state`, `lane` (`fast`|`slow`), `brokerAcceptedCount`, `unconfirmedSince`, `lastReconciliation`, `finishedAt`, `version`. Más `nextSeq` (contador del generador de `eventId`), persistido atómicamente con las entradas.

> **BE14-02:** el `eventId` del outbox cumple la definición canónica única (`src/iot/event-id.ts`: `^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$`, sin `.`, sin normalización). `<claveTécnica>:<seq>` ya la cumple; el firmware debe portar ese patrón exacto.

> **BE14-03:** reglas de lectura válidas confirmadas por el kit de conformidad: `deviceTimestamp` es un **entero ≥ 0** (epoch ms; strings, `null`, flotantes y negativos son cuarentenados por el pipeline) y el payload debe parsear con el parser real del backend; el publisher rechaza localmente lo que no cumpla (`INVALID_DEVICE_TIMESTAMP`, `INVALID_READING:<motivo>`). La certificación de cualquier publisher se hace con `npm run publisher:conformance` (ver `CONTRATO_BE14_03_PUBLISHER_CONFORMANCE.md`).

## State machine
`PENDING_PUBLISH` → (`publish-ok`) `BROKER_ACCEPTED` → (`query-start`) `WAITING_CONFIRMATION` → `CONFIRMED` | `QUARANTINED` | `CONFLICT_REQUIRES_REVIEW` | (`not-confirmed`) `RETRY_REQUIRED` → (`retry-due`) `PENDING_PUBLISH`.
`WAITING_CONFIRMATION` → (`throttled`, HTTP 429) `BROKER_ACCEPTED`. `PENDING_PUBLISH` / `RETRY_REQUIRED` → (`slow-exhausted`) `UNCONFIRMED_EXPLICIT`. `publish-failed` mantiene `PENDING_PUBLISH`.
Terminales: `CONFIRMED`, `QUARANTINED`, `CONFLICT_REQUIRES_REVIEW`, `UNCONFIRMED_EXPLICIT` (sin salidas). **No existe arista de `PENDING_PUBLISH` / `BROKER_ACCEPTED` a `CONFIRMED`** (`INVALID_TRANSITION`). `CREATED` es el instante previo a la primera escritura durable.

## Reglas
1. `submit`: `eventId` estable (contador persistido o provisto), bytes deterministas, `payloadSha256` de esos bytes, `deviceTimestamp` declarado. Mismo `eventId` + mismos bytes ⇒ `ALREADY_PRESENT`; otros bytes ⇒ `REJECTED_EVENT_ID_REUSED_WITH_OTHER_BYTES`; lleno ⇒ `REJECTED_OUTBOX_FULL` (sin consumir `eventId`).
2. PUBACK ⇒ `BROKER_ACCEPTED`. Nunca elimina ni confirma.
3. Éxito ⇔ `processed` | `duplicate-confirmed` | `received-durable`, con `eventId` coincidente en la respuesta.
4. `pending`, `not-found`, estado desconocido, sin respuesta (timeout / 5xx / reset / 404 / malformada / auth) ⇒ `RETRY_REQUIRED`; se republica el **mismo** `eventId` y bytes.
5. `conflict` ⇒ `CONFLICT_REQUIRES_REVIEW` (sin republicación). `quarantined` ⇒ `QUARANTINED`.
6. Carril rápido agotado ⇒ `lane=slow`, `unconfirmedSince`, contador `unconfirmed`; carril lento agotado ⇒ `UNCONFIRMED_EXPLICIT` (retenido; ni éxito ni pérdida).
7. 429 ⇒ se respeta `Retry-After`; sin republicación ni consulta anticipada.
8. MQTT caído / sin red: el evento se conserva; jamás un `eventId` nuevo.
9. Concurrencia: una entrada en proceso a la vez (`inFlight`); cada respuesta se valida contra el `eventId` consultado.
10. Restart: el estado se reconstruye del almacén; las entradas no terminales cuentan como `publisher_restart_recovered`. Un crash entre publish y persistencia se resuelve republicando el mismo `eventId` (at-least-once; el backend deduplica).
11. Una sola conexión MQTT por identidad; `clientId` = clave técnica del dispositivo.

## Puertos
`MqttPublisherPort`; `ReconciliationClient` (HTTP `GET /ingest-confirmations/{eventId}?payloadSha256=`, 404 = ruta ausente, no `not-found`); `ReconciliationAuthProvider` (default `BLOCKED`); `DurableOutboxStore` (memoria y archivo `TEST_ONLY`; el almacenamiento del dispositivo real es decisión pendiente).

## Observabilidad
Contadores: `publish_attempts`, `puback_received`, `reconciliation_queries`, `reconciliation_confirmed`, `reconciliation_pending`, `reconciliation_not_found`, `reconciliation_conflict`, `reconciliation_quarantined`, `unconfirmed`, `retries`, `publisher_restart_recovered` (+ `throttled`, `no_answer`). Gauges: `outbox_depth`, `outbox_oldest_age`. Logs estructurados por allowlist (sin payload, hash ni secretos).
