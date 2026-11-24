# BE13-09 — Matriz de pruebas

## Totales

| Suite | Resultado |
| --- | --- |
| `npm test` completo | **776/776** (752 previas + 24 nuevas) |
| `test/be13-09-operations.test.js` | 16/16 |
| `test/be13-09a-adversarial.test.js` | 8/8 |
| `scripts/verify-be10-http.mjs` | 13/13 equivalentes |
| typecheck / build / `git diff --check` | OK / OK / OK |
| Mongo multi-nodo local (`-Suite be13-09`) | 24/24 × 2 (`MATRIZ_BE13_09_MONGO_REAL.md`) |
| Mutaciones | 5/5 detectadas |

## Offline — operaciones (16)

| Prueba | Cubre |
| --- | --- |
| O-default | placeholder deny-all deniega todo; la denegación se audita |
| O-capabilities | cada operación exige su capacidad; roles/capacidades en la credencial se ignoran |
| O03 realm scope | operador de otro realm denegado aunque conozca el `quarantineId` |
| O-authority | allow sin capacidad, decisiones malformadas, excepción y lentitud → deny |
| O02/O04 | replay autorizado: lease → pipeline → RESOLVED; audit secuencia 1..4 |
| O05/O09 | replay de BLOCKED, DISCARDED o con versión vieja denegado y auditado |
| O06/O07 | resolve exige capacidad + `data-verified` + medición confirmada |
| O08 | discard terminal; reglas de unblock por clase y tipo de evidencia |
| O10 | versión vieja en transiciones (CAS) |
| O11/O12/O13 | replay×replay, resolve×resolve, replay×discard sin estados imposibles |
| O18 | falla de audit bloquea la acción sin cambiar estado |
| Lease release | liberar `REPLAYING` exige `QUARANTINE_REPLAY` y evidencia |
| O19/O20 | métricas con etiquetas acotadas; adapter fallido no altera resultados |
| O21 | alertas sin identificadores |
| O22 | snapshot: solo conteos, `OPERATIONS_VIEW`, `productionReady: false` |
| Readiness | TECHNICAL/OPERATIONS test ready; PRODUCTION siempre false |

## Offline — adversariales (8): ver `MATRIZ_BE13_09A_VECTORES.md`.

## Mutaciones (sobre `dist`, restauradas byte a byte; suites BE13-08/09, línea base 55/55)

| Mutante | Cambio | Detectado por |
| --- | --- | --- |
| M1 realm authorization | `!principal.realms.includes(realm)` → `false` | O-authority |
| M2 CAS version | `record.version !== version.data` → `false` (2 sitios) | O05/O09, O10 |
| M3 audit antes de la acción | `auditRequired` → `return true` | O02/O04, O18, V6 |
| M4 estado de replay | `record.status !== 'RETRYABLE'` → `false` | O05/O09, V7 |
| M5 cardinalidad de métricas | `allowed(v) ? v : 'other'` → `v` | O19/O20, V5 |

El CAS del store Mongo (filtro por `version`) se verifica aparte en la campaña real (O10: transición directa con versión vieja → `stale`).

## Ajustes intencionales a pruebas previas

- BE13-07A V1: lista cerrada de exportaciones de placeholders + 3 nuevos (deny-all, métricas y alertas no configuradas).
- BE13-08A A7: enum de estado con `REPLAYING` y `version.minimum = 1`.
- BE13-07 guard: launcher acepta `be13-07|be13-08|be13-09`.
