# MATRIZ — Escenarios externos BE14-04

Corrida: `node dist/scripts/audit-be14-04-external-selfcheck.js` (EMQX 5.8.6 local + puente de prueba = publisher de referencia con reloj real y MQTT real). Veredicto de la corrida: **HARNESS_SELF_TEST** (un test-double nunca emite `CONFORMANCE PASS EXTERNAL`).

## Escenarios S1–S6
| Id | Falla inyectada (desde afuera) | Qué se observa / afirma | Resultado |
|---|---|---|---|
| S1 | ninguna | conexión vista con clientId = identidad; cada `eventId` publicado; hash observado = hash propio; 3 mediciones exactas | PASS |
| S2 | `brokerDown` → crear 2 eventos → `brokerUp` | ninguno confirma con broker caído; tras recuperar mismos `eventId` y bytes; 0 duplicados | PASS (recuperación ≈ 8 s, incluye arranque de EMQX) |
| S3 | `disconnectClient` | reconexión con el **mismo** clientId; `maxConcurrent ≤ 1`; 0 colisiones | PASS |
| S4 | `reconciliationDown` → `reconciliationUp` | broker acepta pero no hay confirmación; converge sin ids nuevos | PASS |
| S5 | HTTP 429 + `Retry-After` | nunca éxito con 429; converge al normalizar | PASS |
| S6 | **negativo**: mismo `eventId`, bytes distintos en el broker | el kit **debe** detectar `MQTT_RETRY_BYTES_CHANGED` | PASS (detectado) |

## Catálogo L0–L5 en modo externo observado (38 tests)
37 PASS · 0 FAIL · 1 SKIP · 0 NOT_RUN. El SKIP es `L2-04` (`FAULT_CAPABILITY_ABSENT: drop-before-puback`): **no se puede inyectar desde afuera** el corte exacto entre la aceptación del broker y el PUBACK. Por eso el veredicto del catálogo es `CONFORMANCE INCOMPLETE` (un test requerido no corrió) y no `PASS`. El caso sigue cubierto en el mundo simulado (Modo A).

## Capacidades por falla
| Falla | Mundo simulado (Modo A) | Externo observado (Modo B) |
|---|---|---|
| broker caído / vuelve | sí | sí (`docker stop/start` del contenedor propio) |
| reinicio del broker | sí | sí (`docker restart`) |
| desconexión del cliente | sí | sí (API de gestión `DELETE /clients/{id}`) |
| reconciliación caída / 429 / 5xx / timeout | sí | sí |
| backend caído | — | disponible vía `backend{stop,start}` (no usado en S1–S6) |
| corte entre aceptación y PUBACK | sí | **no** (`FAULT_CAPABILITY_ABSENT`) |
| DUP del publisher | n/a | `NOT_OBSERVABLE` |

## Mutantes (≤ 8) — todos detectados
M1 el observador ignora colisión de clientId · M2 acepta reintento con bytes cambiados · M3 acepta hash distinto · M4 acepta topic inválido · M5 el controlador acepta un objetivo no local · M6 la espera no tiene timeout · M7 un fallo del observador pasa a SKIP · M8 un test-double puede reclamar `PASS EXTERNAL`. (`test/be14-04-mutants.test.js`: 8/8 detectados + control sin mutar.)
