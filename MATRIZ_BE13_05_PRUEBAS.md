# BE13-05 — Matriz de pruebas funcionales

Archivo: `test/be13-05-composition.test.js` — **30/30**. Dobles sintéticos explícitos (`test-support/`).

| # | Caso | Resultado | Estado |
| --- | --- | --- | --- |
| 1 | Candidate inválido (clone, spread, `null`, `{}`) | `invalid-candidate`, ninguna dependencia consultada | PROBADO |
| 2 | Trust gate bloqueado | `trust-gate-rejected` / `unresolved-device` | PROBADO |
| 3 | Builder bloqueado (clock bloqueado) | `builder-rejected` / `unresolved-clock` | PROBADO |
| 4 | Realm correcto | `accepted`, `persisted:false` | PROBADO |
| 5 | Realm incorrecto (filas de otro realm; contexto inválido) | no resuelto; `TypeError` | PROBADO |
| 6 | Atribución BE13 = BE12 | `accepted`; evento pasa schema BE-12 | PROBADO |
| 7 | Atribución diferente (otra ventana) | `attribution-drift` / `associationId` | PROBADO |
| 8 | Drift `clientId` | `attribution-drift` / `clientId` | PROBADO |
| 9 | Drift `sensorId` | `attribution-drift` / `sensorId` | PROBADO |
| 10 | Drift `physicalDeviceId` | `attribution-drift` / `physicalDeviceId` | PROBADO |
| 11 | Drift `fieldId` | `attribution-drift` / `fieldId` | PROBADO |
| 12 | Drift `areaId` | `attribution-drift` / `areaId` | PROBADO |
| 13 | Primer evento | `accepted`; clave reclamada | PROBADO |
| 14 | Retry exacto (otra recepción) | `duplicate`; sin reconsultar autoridades | PROBADO |
| 15 | Mismo eventId, payload distinto | `idempotency-conflict` | PROBADO |
| 16 | Mismo eventId, otro realm | independiente; nunca `duplicate` cruzado | PROBADO |
| 17 | Mismo eventId, otra fuente | clave distinta; ambos `accepted` | PROBADO |
| 18 | `null` válido | `value:null`, `missingReason:'absent'` (política sintética) | PROBADO |
| 19 | Cero válido | `0`, `missingReason:null` | PROBADO |
| 20 | Valor ausente | `trust-gate-rejected` / `absent-field`; clave no consumida | PROBADO |
| 21 | A→B | dueño histórico A | PROBADO |
| 22 | A→B→A | evento en ventana B → B | PROBADO |
| 23 | Asociación cambia entre gate y builder | `builder-rejected` / `stale-association` | PROBADO |
| 24 | Dispositivo cambia entre gate y builder | `builder-rejected` / `stale-device` | PROBADO |
| 25 | Dependencias que lanzan (BE-12, idempotencia, store) | `dependency-error` / `idempotency-unavailable` / `trust-gate-rejected`; sin fugas | PROBADO |
| 26 | Respuestas malformadas | contenidas | PROBADO |
| 27 | Determinismo | idéntico | PROBADO |
| 28 | Inmutabilidad y sin alias | congelado; nada compartido | PROBADO |
| 29 | Sin exposición en `app.ts` / rutas | verificado estáticamente | PROBADO |
| 30 | Sin IO externo, reloj ni aleatoriedad en módulos de composición | verificado estáticamente | PROBADO |

## Verificación de mutación (dist, restaurado)

| Mutación | Fallos |
| --- | --- |
| Quitar reconciliación A1 | 8 |
| Ignorar `replay`/`conflict` del claim | 1 |
| Quitar control de realm de BE-12 | 1 |

## Totales

| Suite | Resultado |
| --- | --- |
| BE13-05 funcional | 30/30 |
| BE13-05 E2E | 10/10 |
| BE13-05A adversarial | 13/13 |
| Previas | 611/611 |
| `npm test` | **664/664** |
| HTTP | 13/13 |
