# BE13-08 — Campaña Mongo real (replica set local de 3 nodos)

Entorno: `scripts/be13-07-multinode-local.ps1 -AuthorizeDisposable -Suite be13-08` (MongoDB **8.0.38**, `agro_mn`, solo `127.0.0.1:27071-27073`, tmpfs, limpieza confirmada). SHA `ae71b4c`. **2 ejecuciones: 25 PASS, 0 NO VERIFICABLE, 0 FAIL en cada una.** Docker local ≠ Atlas.

Evidencia: **REAL** (evento real de servidor o red), **SIMULADO** (error inyectado sobre estado Mongo real).

| ID | Escenario | Resultado | Evidencia |
| --- | --- | --- | --- |
| Q01 | Éxito ordinario | PASS | +1 claim / +1 medición |
| Q02 | Duplicado exacto (confirmado en majority) | PASS | misma referencia; 0 escrituras |
| Q03 | Conflicto | PASS | cuarentena BLOCKED `conflict` |
| Q04 | Fallo transitorio → reintento acotado | PASS — SIMULADO | 2 intentos, 1 espera, 1/1 |
| Q05 | **Commit ambiguo REAL** (secondaries pausados; `writeConcernError MaxTimeMSExpired`) | PASS — **REAL** | recovery majority → no confirmado aún → reintento tras sanar → `duplicate` confirmado; +1/+1; sin huérfanos |
| Q05b | Commit real seguido de error ambiguo | PASS — SIMULADO sobre estado REAL | `recovered-committed`; 1 sola llamada de persistencia; +1/+1 |
| Q06 | Transacción abortada → recovery `not-committed` → retry exacto | PASS — abort REAL (fallo inyectado dentro de una transacción real) | 2 intentos; 1/1 |
| Q07 | Claim huérfano (corrupción sintética) | PASS | cuarentena `consistency`, causa `orphan-claim`; evidencia intacta |
| Q08 | Medición huérfana (corrupción sintética) | PASS | cuarentena `consistency`, causa `orphan-measurement`; no se crea claim |
| Q09 | Registro de cuarentena sanitizado | PASS | sin payload ni `x-emqx-key`; claves exactas del schema |
| Q10 | Dedupe | PASS | 1 documento, `attemptCount` 2, 2 entradas de auditoría |
| Q11 | Clasificación reintentable; agotamiento → RETRYABLE | PASS | causa `retry-exhausted` |
| Q12 | Fallo de seguridad no reintentable | PASS | `unverified-hardware` → BLOCKED |
| Q13 | Bloqueo por decisión humana | PASS | `unresolved-clock` → `policy-blocked` BLOCKED |
| Q14 | Aislamiento de cuarentena entre realms | PASS | `preview` no ve entradas de `test` |
| Q15 | Replay permitido | PASS | `accepted` → `RESOLVED`; +1/+1 |
| Q16 | Replay denegado (BLOCKED de seguridad) | PASS | `replay-not-allowed`; 0 escrituras |
| Q17 | Replay con otra identidad | PASS | `replay-identity-mismatch` |
| Q18 | Replay con payload cambiado | PASS | `replay-fingerprint-mismatch`; 0 escrituras |
| Q19 | Auditoría | PASS | `recorded` → `replay` × 2 con fechas del servidor; sin secretos |
| Q20 | Limpieza | PASS (launcher) | `cleanupConfirmed`; 0 contenedores |
| Q21 | 3 replays concurrentes | PASS | +1/+1; `RESOLVED` |
| Q22 | `$jsonSchema` de cuarentena | PASS | 9 documentos inválidos rechazados (121), válido aceptado |
| Q23 | Planes ganadores | PASS | `_id_`, `quarantine_realm_status`, `quarantine_realm_event` |
| Q24 | Consistencia final | PASS | solo quedan las 2 corrupciones sintéticas de Q07/Q08 |

## Verificación de mutación contra Mongo real

Sin el filtro de `realm` en `get` del store de cuarentena (mutación sobre `dist`, restaurado), la campaña falla en **Q14**.
