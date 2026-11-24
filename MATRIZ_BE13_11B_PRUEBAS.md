# BE13-11B — Matriz de pruebas

## Totales

| Suite | Resultado |
| --- | --- |
| `npm test` | **934/934** (897 previas + 22 funcionales + 15 adversariales) |
| `test/be13-11b-durable-inbox.test.js` | 22/22 |
| `test/be13-11b-adversarial.test.js` | 15/15 |
| BE13-11A (fixture con admisión durable) | 38/38 |
| HTTP | 13/13 |
| Mongo `-Suite be13-11b` | 27/27 × 2 |
| Regresión Mongo `be13-11a` / `be13-10b` | 13/13 / 28/28 |
| Mutantes | 6/6 |

## Funcionales (offline, inbox en memoria `TEST_ONLY`)

| Prueba | Cubre |
| --- | --- |
| D01 | Persistencia de una entrega verificada (persist-only); receipt del store; nada ingerido todavía |
| D02 / D03 / D04 / D27 | REJECTED, UNVERIFIED, verifier caído y retained: **no** se persisten; sin cuarentena ni medición |
| D05 | Bytes exactos (espacios y orden de claves preservados) |
| D06 | `rawPersistedAt` del store, distinto de `receivedAt`, `sentAt` y `deviceTimestamp` |
| D07 | No se puede declarar `rawPersistedAt` (contexto, sobre); el camino directo queda `BLOCKED` |
| D08 / D16 | Aislamiento por realm (store y admisión de otro realm) |
| D09 | El `sourceId` sale del mapping |
| D10 | Dos registros, una medición |
| D11 / D12 | Crash recovery con un servicio nuevo; la segunda recuperación da `duplicate`; se ignora un payload nuevo |
| D13 / D14 / D15 | 8 manipulaciones (bytes, hash, `sourceId`, principal, revisión, topic, clave, cantidad de bytes) → integridad; no se repara |
| D17 / D18 | Escritura fallida o receipt malformado u hostil → nada llega al pipeline |
| D19 | Escritura confirmada y pipeline caído → registro intacto y recuperable |
| D20 | 2 y 10 recuperaciones concurrentes → 1 medición |
| D21 / D22 | Audit sin payload; etiquetas cerradas |
| D23 | Readiness con `durableInbox`; placeholder bloqueante; `productionReady` false |
| D24 | Una falla de audit después de persistir no destruye nada |
| D25 | Regresión H2 (IDs sha256) |
| D26 | Regresión H3 (sin cuarentena ni inbox ante rechazos de seguridad) |
| — | Modo de admisión cerrado |

## Adversariales: `MATRIZ_BE13_11B_VECTORES.md`.

## Mutantes

| Mutante | Cambio | Detectado por |
| --- | --- | --- |
| M1 | REJECTED tratado como aceptable (se persiste) | D02, P03, P14, P15 |
| M2 | `rawPersistedAt` aceptado desde la entrega y usado como `persistedAt` | D07, A02, A15 (11A) |
| M3 | Realm fuera de la query de recuperación del store Mongo | **campaña real, I08** |
| M4 | Sin validar el hash en la recuperación | A04 (la manipulación que conserva la longitud) |
| M5 | Pipeline alcanzado aunque falle la escritura del inbox | D17/D18, D23 |
| M6 | `sourceId` del payload usado en el registro | D09, A09 |

## Ajustes a pruebas previas

- Fixture BE13-11A: `observed()` sin `rawPersistedAt`; `boundary.deliver` = admisión durable; `direct` = camino no durable; inbox en memoria `TEST_ONLY` con reloj de servidor sintético posterior a `RECEIVED`.
- P16, P18, P19 y la prueba "dueño de la procedencia" de BE13-11A se adaptaron a la semántica nueva.
- Guard del launcher: suma `be13-11b`.
