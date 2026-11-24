# BE13-08 — Matriz de pruebas

## Offline

| Archivo | Pruebas | Resultado |
| --- | --- | --- |
| `test/be13-08-recovery.test.js` | 21 | 21/21 |
| `test/be13-08a-adversarial.test.js` | 10 | 10/10 |
| Previas (BE13-07 actualizadas a la nueva semántica de readiness y exports) | 721 | 721/721 |
| **`npm test`** | **752** | **752/752** |
| HTTP | — | 13/13 |

### Casos funcionales

| Caso | Estado |
| --- | --- |
| Clasificación determinista y cerrada (16 combinaciones, incluido un objeto hostil como motivo) | PROBADO |
| Máquina de estados: transiciones ilegales rechazadas; seguridad, validación, conflicto y consistencia nunca vuelven a RETRYABLE | PROBADO |
| R1-01 commit confirmado + error ambiguo → `recovered-committed`, 1 sola persistencia | PROBADO |
| R1-02 commit no ocurrido → recovery ausente → retry exacto (misma identidad y fingerprint) → 1/1 | PROBADO |
| R1-03 claim sin medición → cuarentena `consistency` `orphan-claim`; evidencia intacta | PROBADO |
| R1-04 medición sin claim → cuarentena `orphan-measurement`; nada reparado | PROBADO |
| R1-05 fingerprint distinto → conflicto; claim y medición discrepantes → `fingerprint-mismatch` | PROBADO |
| Éxito ordinario y duplicado verificado | PROBADO |
| Agotamiento → RETRYABLE `retry-exhausted`; techo duro de 10; placeholders productivos no reintentan | PROBADO |
| Seguridad, `policy-blocked` (incluido `DEVICE_STATUS_HISTORY_REQUIRED`) y validación → BLOCKED sin consultar la política; sin payload | PROBADO |
| Dedupe (mismo id, `attemptCount` 2) | PROBADO |
| Aislamiento de realm | PROBADO |
| Store o recovery no disponibles → `uncertain` / `persistence-uncertain` | PROBADO |
| Replay permitido, denegado, desbloqueo con evidencia, identidad, fingerprint, auditoría | PROBADO |
| Replays concurrentes → 1 medición | PROBADO |
| Readiness separa retry policy, scheduler, recovery y cuarentena; `productionReady: false` | PROBADO |
| Retraso de replicación: `duplicate` no confirmado en majority → incertidumbre, no corrupción | PROBADO (regresión del hallazgo H1) |

## Mongo real

25/25 × 2 (`MATRIZ_BE13_08_MONGO_REAL.md`).

## Pruebas de mutación (restauradas después)

| Mutación | Detección |
| --- | --- |
| Sin recovery tras commit ambiguo / duplicado | 9 fallos offline |
| Sin límite de retry (ceiling 1000 y política ignorada) | 3 fallos offline |
| Sin preservación de identidad y fingerprint en replay | 1 fallo offline |
| Sin filtro de realm en la cuarentena Mongo | campaña real: FAIL Q14 |
