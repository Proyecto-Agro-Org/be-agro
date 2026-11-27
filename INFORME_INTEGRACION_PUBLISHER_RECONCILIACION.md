# INFORME BE14-01 — Integración del publisher con el contrato de reconciliación E2E (BE13)

Estado: **`REFERENCE_IMPLEMENTATION_ONLY`** (`LOCAL / TEST_ONLY`). `productionReady=false`. BE13 no se reabrió ni se modificó: **no hubo cambios en el backend de BE13** (todo el código nuevo está en `scripts/be14-01/`, no compuesto en `app.ts`).

## 1. Identificación del publisher real
| Repo | Qué es | Veredicto |
|---|---|---|
| `Proyecto-Agro-Org/iot-ingest` (rama `feature/agro-iot-01-seguridad-ingesta`) | API HTTP de ingesta (Express + MongoDB) que recibe eventos desde EMQX; su propio contrato dice *"No se encontró … código de firmware en las fuentes locales"* | **no es un publisher** (servicio de ingesta legacy) |
| `fe-agro` | frontend | no aplica |
| `veritry`, `PDS-Grupo5` | proyectos ajenos | no aplica |
| `be-agro` (scripts de laboratorio 11D–11N) | harness de laboratorio con publishers sintéticos | solo harness |

**Clasificación: C** (solo harness). No existe firmware ESP32 ni simulador MQTT. No se inventó firmware: se construyó una **implementación de referencia ejecutable** en `be-agro`, donde viven el contrato, el backend y los tests. `iot-ingest` quedó intacto.

## 2. Qué se construyó (`scripts/be14-01/`)
- `reference-publisher.ts`: state machine explícita, outbox durable (memoria + archivo atómico con reintento de `rename`), generador de `eventId` con contador persistido, `encodeEvent` determinista, cliente HTTP de reconciliación, puerto `ReconciliationAuthProvider` (default `BLOCKED`, `TEST_ONLY` sintético), política de dos carriles (misma forma que 11N; default `BLOCKED`), métricas cerradas y logs por allowlist.
- `mqtt-port.ts`: puerto MQTT.js con **una conexión por identidad**, `clientId` = clave técnica del dispositivo (nunca aleatorio ni compartido), QoS 1, reapertura perezosa.
Documentos: `CONTRATO_PUBLISHER_OUTBOX.md`, `MATRIZ_PRUEBAS_PUBLISHER_E2E.md`, `RUNBOOK_PUBLISHER_RECONCILIATION.md`.

## 3. Estrategias
| Tema | Estrategia |
|---|---|
| `eventId` | `<claveTécnica>:<seq>`; `seq` persistido junto al outbox (jamás el reloj); fijado en `submit`, no se regenera tras PUBACK, timeout ni `not-found`; charset del parser (sin `.`) |
| `payloadSha256` | SHA-256 de los **bytes exactos** almacenados en el outbox (no se re-serializa); vectores dorados compartidos verifican publisher == backend |
| `deviceTimestamp` | obligatorio para el pipeline (sin él el evento se cuarentena); declarado en la creación y fijo en los reintentos; no es identidad |
| `clientId` | = clave técnica del dispositivo (el boundary rechaza otro valor); una sola conexión; segunda concurrente ⇒ `CLIENT_ID_COLLISION` |
| PUBACK | solo `BROKER_ACCEPTED`; el evento permanece en el outbox |
| éxito | únicamente `processed`, `duplicate-confirmed`, `received-durable` |
| `pending` / `not-found` / desconocido / sin respuesta | nunca éxito ⇒ `RETRY_REQUIRED` ⇒ republicación del mismo `eventId` y bytes |
| `conflict` | terminal `CONFLICT_REQUIRES_REVIEW`, sin republicación |
| `quarantined` | terminal `QUARANTINED`, sin retry infinito |
| carriles | rápido ⇒ alerta `UNCONFIRMED` + lento ⇒ `UNCONFIRMED_EXPLICIT` retenido; valores solo `TEST_ONLY` (no aprobados) |
| saturación | `REJECTED_OUTBOX_FULL` explícito; la lectura rechazada no consume `eventId` |
| HTTP 429 | respeta `Retry-After`; no republica ni consulta antes |

## 4. Hallazgos de la integración
| Sev. | Hallazgo | Estado |
|---|---|---|
| **MEDIUM** | un evento **sin `deviceTimestamp`** es cuarentenado por el pipeline (`invalid-authority-response`): requisito para el publisher que no figuraba como tal. El segundo intento de campaña lo expuso (todo `QUARANTINED`, 0 mediciones) | resuelto en el publisher (`deviceTimestamp` siempre declarado); test B23 contra el boundary real |
| LOW | el patrón de `eventId` de la API de confirmación admite `.` pero el parser del payload no: un `eventId` con `.` se podría consultar pero nunca ingeriría | el publisher usa el patrón estricto; **alinear en un ticket de backend** (BE13 no se tocó) |
| LOW | `rename` atómico del store de archivo falla con `EPERM` transitorio en Windows (el primer intento de campaña abortó) | resuelto: reintento acotado; test B22 |
| INFO | no existe publisher real; la integración con el firmware requiere portar esta referencia (persistencia del dispositivo y transporte MQTT del ESP32 son decisiones pendientes) | documentado |

## 5. Campaña E2E (una; `.local-evidence/be14-01-E2.json`)
Mismo escenario que BE13 (`D13 → D13b`, reproduce F-E2) con el publisher de referencia sobre **MQTT.js real, EMQX real, router/servicio de confirmación reales y evidencia Mongo real**. Honestidad sobre las ejecuciones: la primera abortó por el `EPERM` del store; la segunda completó pero **sin validez** (payloads sin `deviceTimestamp`, todos cuarentenados); la evidencia válida es la tercera, tras corregir ambos defectos **del publisher** (no del backend).
| Métrica | Valor |
|---|---|
| eventos totales | 71 (60 F-E2 + 10 normales + 1 conflicto) |
| PUBACK en la primera pasada (F-E2) | 60/60 |
| F-E2: confirmados / reintentados | **60 / 59** (mismo `eventId` y bytes) |
| normales: confirmados al primer intento | **10/10** |
| conflict (mismo `eventId`, bytes distintos, outbox "perdido") | `CONFLICT_REQUIRES_REVIEW`; 1 publicación, sin republicación; 1 medición para ese `eventId` |
| `quarantined` / `unconfirmed` | 0 / 0 |
| PUBACK sin confirmación | 0 eventos |
| CONFIRMED sin evidencia de backend | 0 |
| mediciones duplicadas | **0** (69 eventos con medición, ninguno con más de 1) |
| caída del API de reconciliación (~6 s) | 74 respuestas `no-answer`, ningún falso éxito; convergencia posterior |
| restart del publisher | outbox reconstruido desde archivo **idéntico** (60 entradas; 20 recuperadas no terminales) |
| conexiones MQTT | máximo 1 abierta |
| cross-tenant | el dispositivo B recibe `not-found` para un evento de A |
| contadores | publish_attempts 203, puback_received 203, reconciliation_queries 203, confirmed 70, not_found 59, retries 133, no_answer 74 |

## 6. Tests
`test/be14-01-reference-publisher.test.js` (23: vectores dorados, state machine, crash C1–C5, cliente HTTP contra router real, puerto MQTT, defaults `BLOCKED`, `deviceTimestamp`) y `test/be14-01-mutants.test.js` (control + 8): **8/8 mutantes muertos** (M1 PUBACK=éxito, M2 nuevo eventId, M3 nuevo hash, M4 restart pierde outbox, M5 `pending` finaliza, M6 conflict reintentado, M7 429 ignorado, M8 respuesta de otro eventId).

## 7. Implementado `TEST_ONLY` vs pendiente de producto/humano
| IMPLEMENTADO TEST_ONLY | PENDIENTE (ninguno `DECIDED`) |
|---|---|
| outbox, state machine, retry de dos carriles, cliente HTTP, 429, crash recovery, métricas/logs, puerto MQTT con regla de `clientId` | fila 72; canal HTTP definitivo; **auth productiva**; valores de retry/slow lane; **política de saturación**; rate limits; migración real; **ownership de `UNCONFIRMED`**; composición productiva del endpoint; persistencia real del outbox en el ESP32; firmware real |

## 8. Próximo ticket recomendado
Portar la referencia al firmware real (o decidir la plataforma) cuando estén aprobadas la auth y la política de retry; y un ticket de backend para alinear el patrón de `eventId` entre la API de confirmación y el parser.
