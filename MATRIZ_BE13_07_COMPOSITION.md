# BE13-07 — Matriz de pruebas del composition root

Archivo: `test/be13-07-root.test.js` — **22/22**. Dobles sintéticos explícitos (`test-support/`); placeholders productivos reales.

| ID | Caso | Resultado | Estado |
| --- | --- | --- | --- |
| R01 | Dependencia faltante (10 dependencias, 4 políticas, métodos parciales, reconocimiento de historial inválido) | `TypeError` | PROBADO |
| R02 | Verifier de procedencia placeholder | `mapper-rejected` / `unverified-provenance` | PROBADO |
| R03 | Hardware placeholder | `trust-gate-rejected` / `unverified-hardware` | PROBADO |
| R04 | Temporal placeholder | `trust-gate-rejected` / `untrusted-clock` | PROBADO |
| R05 | Catálogo placeholder (BE13 y BE-12) | `unapproved-magnitude` / `be12-rejected` `invalid-catalogue` | PROBADO |
| R06 | declaredAt placeholder | `builder-rejected` / `unapproved-declared-at` | PROBADO |
| R07 | clock placeholder | `builder-rejected` / `unresolved-clock` | PROBADO |
| R08 | missingReason placeholder (valor null) | `builder-rejected` / `missing-reason-required` | PROBADO |
| R09 | persistedAt placeholder | `builder-rejected` / `unresolved-persisted-at` | PROBADO |
| R10 | Realm autorizado, leído una vez | `realm` del root y de la atribución; 1 llamada | PROBADO |
| R11 | Realm suplantado en payload/topic | ignorado | PROBADO |
| R12 | Cross-realm; authority inválida o que lanza | `unresolved-device`; `TypeError` | PROBADO |
| R13 | Éxito sintético completo | `accepted`, `persisted:true`, 1/1 | PROBADO |
| R14 | Retry exacto | `duplicate` con la misma referencia | PROBADO |
| R15 | Conflicto | `idempotency-conflict`, sin escritura | PROBADO |
| R16 | Drift de atribución | `attribution-drift` / `clientId`, 0 escrituras | PROBADO |
| R17 | Autoridad stale entre gate y builder | `builder-rejected` / `stale-hardware` | PROBADO |
| R18 | Dispositivo hoy inactivo | `inactive-device` (fail-closed) | PROBADO |
| R19 | Dependencias que lanzan | `persistence-unavailable` / `unverified-provenance`, sin fugas | PROBADO |
| R20 | Dependencias malformadas | `invalid-authority-response` / `dependency-error` | PROBADO |
| — | Readiness con placeholders | `BLOCKED` por dependencia; root por defecto no acepta nada | PROBADO |
| — | Readiness con dobles / faltantes / sin secretos | `READY_FOR_TEST` / `MISSING` | PROBADO |

E2E del root sobre Mongo multi-nodo real: MN-E2E (accepted, duplicate, conflict, cuarentena) en `MATRIZ_BE13_07_MULTI_NODE.md`.

## Totales offline

| Suite | Resultado |
| --- | --- |
| Root | 22/22 |
| Adversarial root | 9/9 |
| Guard multi-nodo | 3/3 |
| Previas | 687/687 |
| **`npm test`** | **721/721** |
| HTTP | 13/13 |
