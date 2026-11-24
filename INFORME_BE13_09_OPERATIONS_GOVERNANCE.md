# BE13-09 — Gobernanza operativa de la ingesta

## Resumen

Se agrega la capa de gobierno operativo sobre la cuarentena y el replay de BE13-08: quién puede operar (autorización por capacidad y realm), con qué evidencia, en qué orden (máquina de estados con CAS por versión y lease de replay), cómo queda registrado (audit append-only en una colección Mongo propia) y cómo se observa (métricas y alertas por puertos). Todo es **offline**: sin endpoints, sin workers, sin scheduler, sin EMQX, sin Atlas, sin hardware. `app.ts` no cambia.

Rama `feature/be13-09-operations-governance` (solo local, sin upstream), worktree `.local-consolidacion/be13-09`, base `dev` `c046956aa9ddb2fdf0f5f6c2e7ff1a95651f4f1c` (merge de BE13-08, PR #28).

Decisiones: `ADR_BE13_09_OPERATOR_AUTHORIZATION.md`, `ADR_BE13_09_AUDIT_RETENTION.md`. Contratos: `CONTRATO_BE13_09_AUTHORIZATION.md`, `CONTRATO_BE13_09_AUDIT.md`, `CONTRATO_BE13_09_OBSERVABILITY.md`.

## Archivos

| Archivo | Rol |
| --- | --- |
| `src/iot/ingestion-operations.contracts.ts` | Operador, capacidades, autorización, evidencia, audit, retención, métricas, alertas, operaciones, bootstrap, readiness |
| `src/iot/ingestion-observability.ts` | Saneamiento de etiquetas (vocabulario cerrado), emisión best-effort acotada en tiempo |
| `src/services/ingestion-operations.service.ts` | Operaciones autorizadas, decoradores de observabilidad/auditoría, readiness, snapshot, bootstrap offline |
| `src/models/ingestion-audit.models.ts` | Colecciones `<prefix>_audit` y `<prefix>_audit_sequences`, `$jsonSchema`, índices, aprovisionamiento |
| `src/repositories/mongo-ingestion-audit.store.ts` | Audit store Mongo: solo `append`, `listForQuarantine`, `ping` |
| `src/iot/ingestion-failure-classification.ts` | Transiciones con `REPLAYING`; vocabulario cerrado `isKnownReasonCode` |
| `src/iot/ingestion-recovery.contracts.ts`, `src/models/ingestion-quarantine.models.ts`, `src/repositories/mongo-ingestion-quarantine.store.ts` | `REPLAYING`, `version` obligatoria, `expectedVersion` (CAS), `summarize()` |
| `src/services/measurement-ingestion-root.ts` | Replay con lease (`leased: true` exige `REPLAYING`); liberación del lease en desajuste de identidad o resultado transitorio |
| `src/adapters/ingestion-production-placeholders.ts` | `createDenyAllOperatorAuthorization`, `createUnconfiguredMetrics`, `createUnconfiguredAlerts` (registrados como bloqueantes) |
| `scripts/audit-be13-09-multinode-local.ts` | Campaña O01–O23 |
| `scripts/be13-07-multinode-local.ps1` | `-Suite be13-07|be13-08|be13-09` (lista cerrada) |

## Flujo de una operación administrativa

validar entrada → autorizar (realm + capacidad; denegación auditada y contada) → validar evidencia → cargar registro → comparar `expectedVersion` → comprobar estado origen → comprobar tipo de evidencia → **audit obligatorio `transition-requested`** (si falla: `audit-unavailable`, sin cambio de estado) → (resolve: recovery debe confirmar la medición con el mismo fingerprint) → transición CAS en el store (`status` + `version`) → audit de resultado best-effort (si falla: alerta `AUDIT_RESULT_MISSING`) → métrica.

Replay: autorizar `QUARANTINE_REPLAY` → `RETRYABLE` y versión → audit obligatorio `replay-requested` → lease CAS `RETRYABLE→REPLAYING` → audit obligatorio `replay-started` (si falla se libera el lease) → pipeline completo BE13-03..08 con la identidad original → `replay-result` best-effort → métricas.

## Hallazgos y correcciones

| ID | Severidad | Hallazgo | Corrección |
| --- | --- | --- | --- |
| H1 | MEDIO | `auditRequired` aceptaba cualquier respuesta no-excepcional de `append` como audit durable (V6). Un adapter defectuoso que devolviera `undefined` habilitaba acciones sin registro. | Se valida el recibo (`realm` literal, `auditId` `a_<hex64>`, `sequence ≥ 1`, estricto). Cubierto por V6 y por el mutante M3 |
| H2 | MEDIO (diseño) | Replay y discard concurrentes podían ambos "ganar": el replay escribía la medición mientras la entrada pasaba a `DISCARDED`. | Lease `REPLAYING` adquirido por CAS antes de tocar el pipeline; discard no admite `REPLAYING` como origen. O13 real: un solo ganador, nunca medición de una entrada descartada |
| H3 | BAJO (diseño) | Se evaluó permitir `BLOCKED→RESOLVED`; debilitaba el store (código en proceso podía resolver entradas bloqueadas por seguridad). | Revertido. `resolve` solo desde `RETRYABLE` y con medición confirmada por recovery |
| H4 | BAJO (proceso) | El launcher multi-nodo no compila: tras un commit solo con typecheck la campaña corrió `dist` desactualizado (2 corridas fallidas en O04). | Recompilar antes de lanzar; documentado. Las corridas válidas son las dos últimas |
| H5 | BAJO (prueba) | O04 de la campaña esperaba una traza sin denegaciones; el servicio audita correctamente las denegaciones en el stream de la cuarentena. | Aserción exacta de las 7 entradas (incluye 3 `authorization-denied`) |

La guardia de exportaciones cerradas de placeholders (BE13-07A V1) y el esquema esperado de A7 (BE13-08A) se actualizaron de forma explícita por los nuevos placeholders y el estado `REPLAYING`.

## Readiness

`describeOperationsReadiness` separa `technicalTestReady` (pipeline BE13-07/08 completo con dobles), `operationsTestReady` (además autorización, audit, métricas, alertas y retención inyectadas y no bloqueantes) y `productionReady`, que es el literal `false` en el tipo y en el valor. Placeholders → `BLOCKED`; `retention: pending-decision` → `BLOCKED`. Limitaciones fijas: `DEVICE_STATUS_HISTORY_REQUIRED`, `AUDIT_RETENTION_PRODUCTION_PENDING`, `EVIDENCE_DECLARED_UNVERIFIED`, `OPERATOR_AUTHENTICATION_EXTERNAL`, `NO_RUNTIME_NO_ENDPOINTS`.

## Riesgos residuales

- La evidencia es declarada (`DECLARED_UNVERIFIED`): el sistema registra la referencia, no verifica el ticket.
- La autenticación del operador es externa: solo existe la autoridad sintética de pruebas y el placeholder deny-all.
- El audit no es WORM: una cuenta Mongo con privilegios de escritura puede modificarlo. No se afirma inmutabilidad.
- El audit de resultado es best-effort: el estado puede cambiar sin entrada de resultado (se emite `AUDIT_RESULT_MISSING`; la entrada `transition-requested` previa siempre existe).
- Un lease `REPLAYING` huérfano (caída del proceso) no expira solo: requiere `releaseLease` autorizado.
- Bypass en proceso: código con acceso directo al store de cuarentena evita la autorización. La frontera de confianza es el bootstrap.
- El contador de secuencia es un documento por stream; el stream `realm` concentra contención.
- Docker local ≠ Atlas.

## Estado

| Categoría | Elementos |
| --- | --- |
| IMPLEMENTADO | Autorización por puerto, capacidades, realm scope, máquina de estados con lease y CAS, evidencia, audit store, métricas, alertas, snapshot, readiness, bootstrap offline |
| PROBADO | 776/776 offline (24 nuevas); Mongo multi-nodo 24/24 × 2; 5/5 mutantes detectados; HTTP 13/13 |
| PENDIENTE | Proveedor de identidad de operadores, mapeo rol→capacidad, retención, verificación de evidencia, backend de métricas y enrutamiento de alertas |
| BLOCKED | Decisiones humanas, EMQX, Atlas, hardware |
| NO VERIFICABLE | Comportamiento en Atlas; WORM |
