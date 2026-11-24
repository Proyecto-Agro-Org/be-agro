# BE13-05 — Matriz E2E local

Archivo: `test/be13-05-e2e.test.js` — **10/10**. Cadena completa: `ProtectedDocument` → mapper BE13-02 (verifier sintético) → gate BE13-03 → builder BE13-04 → BE-12 `resolve()` real sobre adapters realm-scoped → resultado de composición. Store, idempotencia, autoridades y políticas son dobles sintéticos. Sin EMQX, MongoDB ni red.

| ID | Escenario | Resultado | Estado |
| --- | --- | --- | --- |
| E2E-01 | Telemetría sintética válida | `accepted`, valor 21.5 `celsius`, `client-A`, `persisted:false` | PROBADO |
| E2E-02 | Dispositivo desconocido | `trust-gate-rejected` / `unresolved-device` | PROBADO |
| E2E-03 | Asociación histórica | dueño en el instante del evento, no el actual | PROBADO |
| E2E-04 | A→B→A en tres eventos | `client-A`, `client-B`, `client-A` | PROBADO |
| E2E-05 | Retry exacto | `accepted` y luego `duplicate` | PROBADO |
| E2E-06 | Replay alterado (payload; reloj declarado) | `idempotency-conflict` | PROBADO |
| E2E-07 | Cruce de realm (filas, filtración del store, idempotencia, BE-12, contexto ausente) | invisible / `realm-mismatch` / `TypeError` | PROBADO |
| E2E-08 | Drift de atribución antes de BE-12 | `attribution-drift` / `clientId`; clave no consumida | PROBADO |
| E2E-09 | `null` | `accepted`, `null` + motivo de política sintética | PROBADO |
| E2E-10 | Cero (F01) | `accepted`, `0`, `missingReason:null` | PROBADO |
