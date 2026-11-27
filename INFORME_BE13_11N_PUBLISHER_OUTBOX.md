# INFORME BE13-11N — Publisher durable: outbox, retry de dos carriles y reconciliación

Estado: `LOCAL_LAB_EVIDENCE` / `TEST_ONLY`. `productionReady=false`. Ningún valor de política está aprobado (default `BLOCKED`).

## Qué se construyó (`scripts/be13-11n/publisher-outbox.ts`, no importado por la app)
| Pieza | Contrato |
|---|---|
| Outbox | entrada durable por evento: `eventId`, `payloadSha256`, bytes exactos (base64), `createdAt`, `attempts`, `slowAttempts`, `lastAttemptAt`, `nextAttemptAt`, `status`, `lane`, `phase`, `brokerAcceptedCount`, `unconfirmedSince`, `lastConfirmation`. Store de archivo (temp + fsync + rename atómico; archivo corrupto ⇒ falla cerrada) y store en memoria para tests |
| Estados | `PENDING` → `CONFIRMED` / `QUARANTINED` / `CONFLICT` / `UNCONFIRMED_EXPLICIT`. `CONFIRMED` libera capacidad (`compact`); los demás terminales se **retienen** para el operador |
| Carril rápido | espera previa a cada consulta con backoff + jitter; al agotar intentos/tiempo ⇒ alerta `UNCONFIRMED` (`unconfirmedSince`) y pasa al carril lento (el evento sigue en el outbox) |
| Carril lento | intervalo largo hasta `maxElapsed`; al agotarse ⇒ `UNCONFIRMED_EXPLICIT` (ni éxito ni "pérdida") |
| Saturación | `submit` devuelve `REJECTED_OUTBOX_FULL`; **nunca** descarta en silencio. La política de qué hacer con el evento rechazado queda como decisión humana |
| Reuso de `eventId` | mismos bytes ⇒ `ALREADY_PRESENT`; otros bytes ⇒ `REJECTED_EVENT_ID_REUSED_WITH_OTHER_BYTES` (nunca se sobrescribe) |
| Reintento | siempre el mismo `eventId` y los mismos bytes almacenados; `conflict` y `quarantined` son terminales y no se reintentan |
| Restart | un publisher nuevo sobre el mismo archivo retoma `attempts`, `phase` y fechas; crash entre publish y persist ⇒ se re-publica el mismo `eventId` (at-least-once) |
| Política | `OutboxPolicy` inyectable; default `BLOCKED`; `PROPOSED_OUTBOX_POLICY` = propuesta de 11K (3 s ×2, tope 60 s, ±25 %, 8 intentos, 10 min; lento 15 min hasta 24 h), **solo `TEST_ONLY`** |

## Hallazgo sobre `clientId` (corrige la hipótesis de 11J)
`mqtt-ingestion-boundary.service.ts` rechaza (`technical-identity-mismatch`) toda entrega cuyo `mqttClientId` no coincida con la clave técnica del dispositivo: **el `clientId` MQTT es la identidad del dispositivo**. Por eso "un `clientId` distinto por conexión" no es una solución válida; la correcta es **una sola conexión por identidad de publisher** (MQTT además expulsa a la conexión previa con el mismo `clientId`). El outbox serializa todas las publicaciones sobre una conexión y la reabre si el broker la cierra. El arnés de 11J violaba esto con 20 conexiones concurrentes del mismo `clientId`.

## Campaña única (`.local-evidence/be13-11n-N1.json`)
`D13 → D13b` (configuración histórica), publisher con outbox de archivo, confirmación por el router HTTP real (TEST_ONLY) sobre evidencia Mongo real; las confirmaciones se **retienen** hasta que termina la ventana original (se reproduce F-E2 igual que en 11H/11I: 1 propio entregado, 59 no, 60 stale). A los ~8 s de reanudar se simula un **crash/restart del publisher**: el outbox reconstruido desde el archivo es idéntico.
| Métrica | Valor |
|---|---|
| eventos con PUBACK en la primera pasada | 60 |
| estados finales | **CONFIRMED 60**, QUARANTINED 0, CONFLICT 0, UNCONFIRMED 0, pendientes 0 |
| reintentados | 59 (1 reintento cada uno; 119 publicaciones totales; 1 confirmado en el primer intento) |
| PUBACK sin confirmación | 0 eventos (el PUBACK nunca decidió) |
| CONFIRMED sin evidencia de backend | 0 (contrastado contra claims e inbox con hash) |
| eventos con > 1 medición | **0** |
| conexiones del publisher | 2 abiertas (inicial + reapertura tras el restart del broker/crash simulado); **máximo concurrente 1** |
| crash/restart | 60 entradas antes/después, idénticas (`eventId`, hash, intentos, estado, carril, fase) |
| cross-tenant | el dispositivo B pregunta por un evento de A ⇒ `not-found` |
| duración de la reconciliación | 12 s |
Comparación con 11J (misma secuencia): con 20 conexiones del mismo `clientId` quedaron 3 sin confirmar; con una conexión por identidad **quedaron 0** — consistente con la hipótesis de colisión (no es un experimento aislado, se cambiaron varias cosas a la vez). El exit code fue 0 (no reapareció el `authn_400` de 11J).

## Tests y mutantes
`test/be13-11n-publisher-outbox.test.js` (15) + `test/be13-11n-mutants.test.js` (control + 8): M1 PUBACK final, M2 eventId derivado, M3 descarte silencioso por saturación, M4 restart ignora el estado, M5 reuso de `eventId` aceptado, M6 conflict reintentado, M7 slow lane agotado ⇒ éxito, M8 `pending` ⇒ confirmado. **8/8 muertos**, control limpio.

## Limitaciones / decisiones humanas
- Valores de política (carriles, capacidad, descarte ante saturación), quién atiende `UNCONFIRMED`, y la persistencia real del outbox en el dispositivo (aquí un archivo local) son decisiones humanas.
- Sin batch endpoint ni integración con un firmware real; el publisher es una referencia `TEST_ONLY`.
- Una campaña, una versión de broker; un solo publisher en la campaña (el aislamiento multi-tenant se verificó por consulta cruzada, no con dos outboxes concurrentes).
