# MATRIZ BE14-01 — Pruebas del publisher de referencia

## Offline (`test/be14-01-reference-publisher.test.js`, 23 tests)
| Cubre | Test |
|---|---|
| vectores dorados (6): bytes, `eventId`, hash publisher == backend == esperado, parseo del backend | B1 |
| `eventId` estable, contador persistido tras restart, charset estricto, reuso | B2 |
| state machine y transiciones inválidas (PUBACK ⇒ CONFIRMED imposible) | B3 |
| semántica de PUBACK; éxito solo con confirmación | B4 |
| tabla de estados: processed/duplicate/received-durable ⇒ éxito; quarantined/conflict terminales; pending/not-found/desconocido/sin respuesta ⇒ no éxito | B5 |
| F-E2 simulado (PUBACK sin delivery) | B6 |
| dos carriles, `UNCONFIRMED`, agotamiento | B7 |
| saturación explícita; reuso de `eventId` | B8 |
| MQTT caído; API de reconciliación caída | B9, B10 |
| 429 + `Retry-After` | B11 |
| crash C1–C5 (antes de publish; tras publish sin persistir; tras PUBACK; tras respuesta del backend; tras confirmación) ⇒ 1 medición | B12 |
| restart con almacén de archivo | B13 |
| concurrencia (20 eventos, respuestas por `eventId`) | B14 |
| métricas y logs seguros | B15 |
| cliente HTTP: 200 / malformada / 429 / 401 / 403 / 404 / 5xx / reset / timeout / auth BLOCKED | B16 |
| cliente contra router + servicio reales: confirmado, cross-tenant, conflict, quarantine, auth denegada | B17 |
| puerto MQTT: `clientId` = clave técnica, una conexión, reapertura | B18 |
| defaults `BLOCKED`, no compuesto en el backend | B19 |
| invariantes del módulo real | B20 |
| cableado de la campaña | B21 |
| `rename` con reintento acotado | B22 |
| `deviceTimestamp` requerido por el pipeline real | B23 |

## Mutantes (`test/be14-01-mutants.test.js`): 8/8 muertos
M1 PUBACK=éxito · M2 retry con nuevo `eventId` · M3 retry con nuevo hash · M4 restart pierde outbox · M5 `pending` finaliza · M6 conflict reintentado · M7 429 ignorado · M8 respuesta de otro `eventId` aceptada.

## Campaña E2E (EMQX + Mongo reales; `.local-evidence/be14-01-E2.json`)
| Caso | Esperado | Observado |
|---|---|---|
| normal (10) | confirmados al primer intento | 10/10 |
| PUBACK sin delivery (60, F-E2) | detecta ⇒ retry ⇒ converge | 60/60 confirmados, 59 reintentados |
| caída del API de reconciliación (~6 s) | sin falso éxito; converge | 74 `no-answer`; 0 falsos éxitos |
| restart del publisher | outbox recuperado | idéntico (60 entradas) |
| duplicados | 0 mediciones duplicadas | 0 |
| conflict (mismo id, otros bytes) | `CONFLICT_REQUIRES_REVIEW` sin retry | sí; 1 medición para ese id |
| cross-tenant | sin acceso a evidencia ajena | `not-found` |
| PUBACK sin confirmación / CONFIRMED sin evidencia | 0 / 0 | 0 / 0 |
