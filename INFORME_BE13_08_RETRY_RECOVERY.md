# BE13-08 — Reintentos, recuperación de commits ambiguos, cuarentena y replay

## Resumen

Se resuelven R1 (commit ambiguo), Q1 (cuarentena persistente y auditable) y Q2 (replay seguro), solo en local: sin EMQX, sin Atlas, sin runtime. Rama `feature/be13-08-retry-quarantine-recovery`, worktree `.local-consolidacion/be13-08`, base `dev` `8bd99f4129480b1c9ff74bb8abf98ba6f815c2a3` (merge de BE13-07, PR #27).

Decisiones: `ADR_BE13_08_RETRY_SEMANTICS.md`, `ADR_BE13_08_QUARANTINE.md`. Contratos: `CONTRATO_BE13_08_RETRY.md`, `CONTRATO_BE13_08_QUARANTINE.md`.

## Archivos

| Archivo | Rol |
| --- | --- |
| `src/iot/ingestion-recovery.contracts.ts` | Clases, política, scheduler, recovery, cuarentena, root resiliente, replay |
| `src/iot/ingestion-failure-classification.ts` | Clasificación determinista + máquina de estados |
| `src/repositories/mongo-persistence-recovery.repository.ts` | Recovery read-only (majority) |
| `src/repositories/mongo-ingestion-quarantine.store.ts` | Cuarentena Mongo (dedupe, transiciones, auditoría) |
| `src/models/ingestion-quarantine.models.ts` | Colección, `$jsonSchema`, índices, aprovisionamiento |
| `src/services/measurement-ingestion-root.ts` | `createResilientMeasurementIngestionRoot`, replay, readiness extendido; ensamblado privado compartido con el root BE13-07 (sin cambio de comportamiento) |
| `src/adapters/ingestion-production-placeholders.ts` | Política y scheduler de reintentos bloqueantes |
| `scripts/audit-be13-08-multinode-local.ts` | Campaña Q01–Q24 |
| `scripts/be13-07-multinode-local.ps1` | `-Suite be13-07|be13-08` (lista cerrada) |

## Flujo

`ingest` → mapper (identidad fija) → por cada intento: composición BE13-03..06 → `accepted` | `duplicate` (confirmado por recovery majority) | fallo → clasificación → ambiguo: recovery primero → no reintentable: cuarentena → reintentable: política → scheduler → retry con la misma identidad → al agotar: cuarentena RETRYABLE.

## Hallazgos y correcciones

| ID | Severidad | Hallazgo | Corrección |
| --- | --- | --- | --- |
| H1 | MEDIO | El lookup lee el claim con concern `local` y el recovery con `majority`: con retraso de replicación, un claim recién confirmado se clasificaba como `orphan-claim` (corrupción) y se bloqueaba. Ocurrió en el escenario real Q05. | `duplicate` + `not-committed` = incertidumbre transitoria (`persistence-uncertain`, retry); los huérfanos visibles en majority siguen siendo inconsistencias |
| H2 | BAJO | Una segunda lectura del recovery podía devolver un resultado inválido si competía con un cambio. | Se clasifica el informe ya leído (una lectura por decisión) |
| H3 | BAJO | Las respuestas de recovery y cuarentena (dependencias inyectadas) no se validaban. | Validación Zod estricta; malformadas → incertidumbre |
| H4 | BAJO | `READY_FOR_TEST` podía leerse como "listo" (BE13-07). | Campo literal `productionReady: false` (publicado con BE13-07) |

## Readiness

`describeIngestionRootReadiness` reporta por separado `retryPolicy`, `retryScheduler`, `recovery` y `quarantine`. El pipeline base sin esas cuatro dependencias ya no es `READY_FOR_TEST` (R1 quedaría abierto). Placeholders → `BLOCKED`. `productionReady` es siempre `false`.

## Riesgos residuales

- Partición prolongada: el resultado queda en cuarentena RETRYABLE; no hay replay automático.
- Quien autoriza `transition`/`replay` (operador, rol) no está definido: no hay endpoint.
- `maxAttempts`, backoff y el techo de 10 no son SLO; los valores productivos siguen pendientes.
- La auditoría está embebida y acotada a 100 entradas; para retención larga haría falta una colección propia.
- Docker local ≠ Atlas.

## Estado

| Categoría | Elementos |
| --- | --- |
| IMPLEMENTADO | Recovery, clasificación, política y scheduler inyectables, cuarentena, replay, root resiliente, readiness |
| PROBADO | 752/752 offline; Mongo multi-nodo 25/25 × 2; 4 mutaciones detectadas; HTTP 13/13 |
| PENDIENTE | Política productiva de reintentos y backoff, autorización de operadores, retención de auditoría, monitoreo y alertas |
| BLOCKED | Decisiones humanas (BLOCKED_BY_POLICY), EMQX, Atlas, hardware |
| NO VERIFICABLE | Comportamiento en Atlas |
