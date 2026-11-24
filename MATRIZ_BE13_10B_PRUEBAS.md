# BE13-10B — Matriz de pruebas

## Totales

| Suite | Resultado |
| --- | --- |
| `npm test` | **859/859** (825 previas + 21 funcionales + 13 adversariales) |
| `test/be13-10b-lease-governance.test.js` | 21/21 |
| `test/be13-10b-adversarial.test.js` | 13/13 |
| `scripts/verify-be10-http.mjs` | 13/13 |
| Mongo `-Suite be13-10b` | 28/28 × 2 |
| Regresión Mongo `-Suite be13-09` / `-Suite be13-08` | 24/24 / 25/25 |
| Mutantes | 6/6 detectados |

## Funcionales (offline)

| Prueba | Cubre |
| --- | --- |
| B01 | Dueño = `operatorId` autorizado; `acquiredAt` = tiempo confiable; token = versión; lease solo en `REPLAYING` |
| B02 | El dueño libera su lease activo |
| B03 | Un no-dueño no libera ni recupera un lease activo |
| B04 | Realm ajeno: adquisición, liberación y recuperación denegadas |
| B05 | Versión vieja en adquisición, liberación y recuperación |
| B06 | Tiempo no confiable: no hay adquisición ni expiración; el dueño puede liberar igual |
| B07 | Respuestas malformadas de la autoridad temporal |
| B08 | Política que lanza, malformada, de otro realm, `never` o estado desconocido |
| B09/B10 | `ACTIVE` explícito bloquea; `EXPIRED` explícito permite la recuperación autorizada y luego una nueva adquisición |
| B11 | Recuperación sin `QUARANTINE_UNBLOCK` o con credencial desconocida |
| B12/B13 | 2 y 10 recuperaciones concurrentes → un ganador |
| B14/B23/B25b | S7 expirado: A en curso → B recupera → B descarta → A cercado, 0 mediciones, `DISCARDED` |
| B14b | Recuperación y readquisición por B: A cercado, B persiste, 1 medición |
| B15/B25a | S7 activo (reproducción exacta): B no libera, no recupera, no descarta; A persiste |
| B16 | Replay vs discard concurrentes |
| B18 | Lease presentado que no se posee (dueño o token) → stale antes de cualquier trabajo |
| B21/B22/B24 | Audit: lease adquirido; recuperación denegada; falla de audit bloquea la recuperación y la liberación |
| — | Fence del replay sin lease (BE13-08) frente a un discard |
| — | Adaptador sin `replayFencing` → rechazado; lease devuelto; sin escritura |
| — | Readiness `timeAuthority` y `leasePolicy`; placeholders: no se adquiere |

## Adversariales: ver `MATRIZ_BE13_10B_VECTORES.md`.

## Mutantes (sobre `dist`, restaurados byte a byte)

| Mutante | Cambio | Dónde se detecta |
| --- | --- | --- |
| M1 dueño (S7) | sin `lease.ownerId !== principal.operatorId` | offline: liberación de lease, A01, B03, B15/B25a |
| M2 fence de la raíz | el fence siempre devuelve `true` | offline: A06, B14/B25b, fence sin lease |
| M3 expiración | tiempo no confiable → `EXPIRED` | offline: B06, B07 |
| M4 versión | sin los 3 controles de `expectedVersion` | offline: O05/O09, O10, B05 |
| M5 realm | sin `realm` en los filtros de `acquireLease` y `settleReplay` (Mongo) | campaña real: falla en B04 |
| M6 fence del adaptador | el adaptador Mongo ignora el resultado del fence | campaña real: falla en B17 (escritura stale) |

Sobre M4: la unicidad del ganador en concurrencia no depende de `expectedVersion`, porque la garantiza la CAS de estado, dueño y token (B12/B13 siguen pasando con M4). La versión protege la **intención vieja** del operador y la detectan las pruebas de versión vieja.

## Ajustes intencionales a pruebas previas

- BE13-09 O02/O04: la traza suma `lease-acquired` (5 entradas).
- BE13-09, test de liberación del lease: ahora prueba dueño contra no-dueño y que el `transition` genérico no entra a `REPLAYING`.
- BE13-08 replay: la transición la registra el fence (`replay-persisted`).
- Los wrappers de persistencia de prueba reenvían `options` y declaran `replayFencing`.
- BE13-09 y BE13-10A inyectan `timeAuthority` y `leasePolicy` sintéticas.
- Guard del launcher: lista cerrada con `be13-10b`.
