# CONTRATO BE13-11J — `IngestConfirmation` (confirmación end-to-end del backend)

Estado: prototipo local `TEST_ONLY`. No compuesto en `app.ts`, no habilitado en Production, `productionReady=false`. Ninguna decisión productiva queda tomada.

## 1. Principio: tres niveles que no se mezclan
| Nivel | Qué significa | Quién lo afirma |
|---|---|---|
| `BROKER_ACCEPTED` | El publisher recibió MQTT PUBACK: el broker aceptó el publish según su semántica | el broker |
| `INGEST_DURABLE` | El backend tiene el evento en el Durable Inbox (registro crudo durable, lectura majority) | el backend |
| `INGEST_CONFIRMED` | El backend demuestra que el `eventId` quedó **procesado** (claim + medición en una transacción), **recibido de forma durable**, o **resuelto idempotentemente** | el backend |

PUBACK, `sessionPresent`, colas/inflight del broker y una recepción en memoria **no** son evidencia. El protocolo MQTT y el PUBACK no se tocan ni se reinterpretan.

## 2. Clave de reconciliación: `eventId`
Auditoría (código real, `ingestion-composition.contracts.ts`, `mongo-measurement-persistence.repository.ts`): la identidad de idempotencia es `{realm, sourceId, operation, eventId, field}` con índice único; `sourceId` lo deriva el servidor del **principal autenticado** (nunca del payload ni del topic).
| Requisito | Resultado |
|---|---|
| unicidad | por `(realm, sourceId, eventId)`; dos tenants pueden coincidir en el texto sin chocar |
| estabilidad | el publisher fija el `eventId`; el reintento lo conserva (test J16, M2) |
| independencia del `clientId` MQTT | la clave no incluye `clientId` |
| determinismo | lo determina el publisher, no el contenido |
| protección multi-tenant | el scope viene del servidor; las lecturas filtran por `realm` + `sourceId` |
No se crea otro identificador. **Límite abierto:** un `eventId` reutilizado con *contenido distinto* se detecta como `conflict` al persistir, pero una consulta solo por `eventId` no lo distingue: el publisher no debe reutilizar un `eventId` para otro contenido.

## 3. Estados (`IngestConfirmationStatus`)
| Estado | `confirmed` | Evidencia exigida |
|---|---|---|
| `processed` | sí | claim `committed` (majority) con `realm`+`sourceId`+`eventId` |
| `duplicate-confirmed` | sí | claim `committed` **y** ≥ 2 registros durables del mismo evento en el inbox (se admitió más de una vez y se resolvió idempotentemente) |
| `received-durable` | sí | registro durable en el inbox, sin claim todavía (el reconciliador del backend lo procesa) |
| `quarantined` | **no** | fila de cuarentena del tenant; gana sobre el inbox; estado controlado, nunca éxito |
| `pending` | **no** | alguna fuente de evidencia no respondió y no hay evidencia positiva: el backend no puede demostrar el estado |
| `not-found` | **no** | todas las fuentes respondieron y ninguna tiene el evento (indistinguible para un evento ajeno) |
Cualquier valor desconocido tampoco es éxito. Orden de precedencia: claim > cuarentena > inbox > fuente no disponible (`pending`) > `not-found`.

## 4. Forma de la respuesta
`{ eventId, realm, status, confirmed, evidenceVersion: 1, evidence: { claim|inbox|quarantine: present|absent|unavailable }, deliveries, durableAt }` (el endpoint HTTP expone `eventId, status, confirmed, evidenceVersion, deliveries, durableAt`; no expone ids internos). `durableAt` = instante de la base (claim, o inbox si no hay claim). La respuesta es inmutable.

## 5. Fail-closed
Ausencia de error, PUBACK previo, timeout vencido o inferencia **nunca** producen un estado confirmado. Una fuente que falla degrada a `pending`; una evidencia con scope ajeno o malformado se ignora (defensa en profundidad, M3).

## 6. Aislamiento multicliente
`scopeOf(principal) → {realm, sourceId}` lo resuelve el servidor; la consulta no puede ampliarlo (ni por path, ni por query). Un `eventId` ajeno devuelve **la misma respuesta** que uno inexistente (`not-found`, HTTP 200): no revela existencia. Sin autenticar: 401; sin scope: 403; `eventId` inválido: 400; fallo interno: 503 (el publisher no lo lee como éxito).

## 7. Superficie
`GET /ingest-confirmations/:eventId` (Express `Router` creado por `createIngestConfirmationRouter`, exige `mode: 'TEST_ONLY'`; cualquier otro modo lanza). Solo lectura: sin escrituras, sin índices nuevos, sin cambios de schema.

## 8. Política de retry del publisher
`PublisherRetryPolicy`: `initialDelayMs`, `maxAttempts` (1–20), `backoffFactor` (≥1), `maxDelayMs`, `maxElapsedMs`. El default productivo es `BLOCKED` (lanza). Agotado el presupuesto el resultado es `UNCONFIRMED_EXPLICIT`: ni éxito ni "pérdida" declarada.
