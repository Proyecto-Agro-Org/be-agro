# MATRIZ BE14-03 — Pruebas de conformidad

`W` = necesita el mundo MQTT/HTTP (en modo externo ⇒ `NOT_RUN`); `—` = solo adapter. `Cap` = capacidad requerida (si falta: FAIL, salvo `opcional`/`SKIP` indicado).

## Catálogo (38) — modo A: todos PASS
| ID | Nivel | Qué prueba | W | Cap | failureCode principal |
|---|---|---|---|---|---|
| L0-01 | 0 | vectores: bytes, SHA-256, parser, `eventId`, `deviceTimestamp`, topics | — | | `VECTOR_*` |
| L0-02 | 0 | `eventId` canónico y único | — | | `EVENTID_NOT_CANONICAL`, `EVENTID_NOT_UNIQUE` |
| L0-03 | 0 | forma del payload con el parser real; `deviceTimestamp`; topic | — | | `PAYLOAD_NOT_PARSEABLE`, `DEVICE_TIMESTAMP_MISSING` |
| L0-04 | 0 | hash == SHA-256 de los bytes publicados == hash consultado | W | | `HASH_MISMATCH_BACKEND`, `QUERY_HASH_MISMATCH` |
| L0-05 | 0 | serialización determinista | — | canonical-serialization (opcional ⇒ SKIP) | `SERIALIZATION_NOT_DETERMINISTIC` |
| L0-06 | 0 | `deviceTimestamp`: solo entero ≥ 0 se acepta (11 vectores) | — | explicit-event-input | `DEVICE_TIMESTAMP_RULE` |
| L0-07 | 0 | topic publicado válido | W | | `TOPIC_INVALID` |
| L0-08 | 0 | forma de la consulta (`GET`, path, solo `payloadSha256`, solo su principal) | W | | `QUERY_PATH`, `QUERY_PARAMS`, `QUERY_PRINCIPAL` |
| L0-09 | 0 | `eventId` no canónicos y payload malformado rechazados, sin entrar al outbox | — | explicit-event-input | `INVALID_EVENTID_ACCEPTED`, `MALFORMED_PAYLOAD_ACCEPTED` |
| L1-01 | 1 | entrega normal (1 publish, 1 medición por evento) | W | | `NOT_CONFIRMED`, `EXTRA_PUBLISH` |
| L1-02 | 1 | **PUBACK ≠ éxito** | W | | `PUBACK_AS_SUCCESS`, `EVENT_DISAPPEARED` |
| L1-03 | 1 | semántica de confirmación (8 estados) | W | | `NON_CONFIRMING_STATUS_ACCEPTED`, `WRONG_TERMINAL_STATE` |
| L1-04 | 1 | `clientId` = clave técnica, estable, una conexión | W | | `CLIENTID`, `CLIENTID_COLLISION` |
| L1-05 | 1 | reconexión con el mismo `clientId` | W | | `CLIENTID_CHANGED`, `NO_RECONNECT` |
| L2-01 | 2 | retry: mismo `eventId`/bytes/hash, converge | W | | `RETRY_CHANGED_IDENTITY`, `NO_RETRY` |
| L2-02 | 2 | duplicado seguro | W | | `DUPLICATE_MEASUREMENT` |
| L2-03 | 2 | confirmación perdida (timeouts) | W | | `CONFIRMED_WITHOUT_ANSWER` |
| L2-04 | 2 | conexión caída antes de PUBACK | W | | `RETRY_CHANGED_IDENTITY` |
| L2-05 | 2 | conexión caída después de PUBACK | W | | `CONFIRMED_WITHOUT_ANSWER` |
| L2-06 | 2 | `conflict` terminal, sin retry, sin fuga del hash ajeno | W | | `CONFLICT_NOT_TERMINAL`, `CONFLICT_RETRIED`, `CONFLICT_LEAK` |
| L2-07 | 2 | `quarantined` terminal | W | | `QUARANTINE_NOT_TERMINAL`, `QUARANTINE_RETRIED` |
| L2-08 | 2 | HTTP 429 + `Retry-After` | W | | `RETRY_AFTER_IGNORED`, `REPUBLISH_ON_429`, `CONFIRMED_ON_429` |
| L2-09 | 2 | HTTP 401/403 sin éxito ni bucle agresivo | W | | `CONFIRMED_ON_AUTH_FAILURE`, `AGGRESSIVE_RETRY` |
| L2-10 | 2 | HTTP 5xx conserva y reintenta | W | | `CONFIRMED_ON_5XX` |
| L3-01 | 3 | restart: mismas entradas/bytes/hash; continúa | W | | `OUTBOX_LOST_ON_RESTART` |
| L3-02 | 3 | crash C1–C6 (antes de persistir; antes de publish; tras publish sin persistir; tras PUBACK; tras respuesta del backend; tras confirmación) | W | crash-injection | `C1_SILENT_ACCEPT`, `C_SILENT_LOSS`, `DUPLICATE_MEASUREMENT` |
| L3-03 | 3 | outbox corrupto fail-closed; `.tmp` parcial no reemplaza el último estado válido | — | outbox-corruption | `CORRUPT_OUTBOX_SILENT`, `TORN_WRITE_LOST_STATE` |
| L3-04 | 3 | secuencia persistente tras restart | — | | `EVENTID_COLLISION` |
| L3-05 | 3 | reloj repetido/retrocedido | — | clock-control | `EVENTID_FROM_CLOCK` |
| L3-06 | 3 | sin pérdida silenciosa (incluye terminales) | W | | `SILENT_LOSS` |
| L4-01 | 4 | MQTT caído: retiene y recupera | W | | `WRONG_STATE_WHILE_DOWN` |
| L4-02 | 4 | reconciliación no disponible (reset/timeout/5xx) | W | | `CONFIRMED_WITHOUT_ANSWER` |
| L4-03 | 4 | saturación: retenido o rechazado, nunca descarte silencioso | W | capacity-config (ausente ⇒ SKIP `DECISION_PENDING:outbox-capacity`) | `SILENT_DROP`, `NO_BACKPRESSURE` |
| L4-04 | 4 | carril rápido finito → lento → agotamiento explícito, el evento no se descarta | W | policy-config (ausente ⇒ SKIP `DECISION_PENDING:retry-policy-values`) | `NO_SLOW_LANE`, `NO_EXPLICIT_EXHAUSTION`, `RETRY_NOT_FINITE` |
| L4-05 | 4 | concurrencia: 20 eventos, confirmaciones no cruzadas | W | | `CONFIRMATION_CROSSED`, `HASH_MIXED` |
| L5-01 | 5 | confirmación de otro `eventId` rechazada | W | | `FOREIGN_CONFIRMATION_ACCEPTED` |
| L5-02 | 5 | malformada / estado desconocido ⇒ fail-closed | W | | `MALFORMED_ACCEPTED` |
| L5-03 | 5 | scope: solo su identidad; otro tenant ve lo ajeno como inexistente | W | | `FOREIGN_PRINCIPAL_USED`, `CROSS_TENANT_LEAK` |

## Campaña integrada (9, EMQX + Mongo + router reales) — todos PASS
INT-L1-01 sanos confirmados al primer intento · INT-L1-02 PUBACK nunca éxito / sin evidencia · INT-L1-03 una conexión MQTT · INT-L2-01 F-E2 real converge (60/60, 59 reintentos) · INT-L2-02 0 duplicados · INT-L2-03 conflict terminal · INT-L3-01 outbox idéntico tras restart · INT-L4-01 caída del API sin falso éxito · INT-L5-01 cross-tenant `not-found`.

## Mutantes del kit (8/8 rechazados)
| Mutante | Prueba que lo rechaza | Código |
|---|---|---|
| M1 PUBACK=éxito | L1-02 | `PUBACK_AS_SUCCESS` |
| M2 retry con nuevo `eventId` | L2-01 | `RETRY_CHANGED_IDENTITY` / `NOT_CONFIRMED` |
| M3 retry con bytes distintos | L2-01 | `RETRY_CHANGED_IDENTITY` / `NOT_CONFIRMED` |
| M4 restart limpia outbox | L3-01 | `OUTBOX_LOST_ON_RESTART` |
| M5 `pending` confirma | L1-03 | `NON_CONFIRMING_STATUS_ACCEPTED` |
| M6 conflict reintentado | L2-06 | `CONFLICT_NOT_TERMINAL` / `CONFLICT_RETRIED` |
| M7 confirmación de otro evento aceptada | L5-01 | `FOREIGN_CONFIRMATION_ACCEPTED` |
| M8 descarte silencioso | L4-03 | `SILENT_DROP` |

## Modo externo (preparado)
Con el puente de prueba: L0 independientes del mundo ⇒ PASS; el resto ⇒ `NOT_RUN` (`EXTERNAL_MQTT_WORLD_NOT_IMPLEMENTED`), veredicto `INCOMPLETE`, salida 4.
