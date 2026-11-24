# BE13-08 — Contrato de reintentos y recuperación

## Factory

`createResilientMeasurementIngestionRoot(deps)`: todas las dependencias del root BE13-07 **más** `retryPolicy`, `retryScheduler`, `recovery` y `quarantine`, todas obligatorias (`TypeError` si falta alguna). `createMeasurementIngestionRoot` (BE13-07) no cambia.

```ts
root.ingest(protectedDocument, provenanceEvidence, { field }) → ResilientIngestionResult
```

| Resultado | Significado |
| --- | --- |
| `accepted` | medición persistida en este intento (`measurementId`, `attempts`) |
| `duplicate` | ya persistida con el mismo contenido; **confirmado en majority** |
| `recovered-committed` | commit ambiguo resuelto por recovery: estaba confirmado; cero escrituras nuevas |
| `quarantined` | registrado en cuarentena (`quarantineId`, `quarantineStatus`, `reasonCode`, `retryClass`) |
| `uncertain` | no se pudo registrar la cuarentena (`quarantine-unavailable`): reintentar con la misma entrada |

## Puertos

```ts
IngestionRetryPolicy.decide({ realm, attempt, retryClass: 'transient', reasonCode }) → { action: 'retry' | 'stop' }
RetryScheduler.wait({ attempt, reasonCode }) → Promise<void>
PersistenceRecoveryPort.inspect(key) → { state: 'committed', measurementId, fingerprint } | { state: 'not-committed' } | { state: 'inconsistent', inconsistency }
```

- Solo los fallos `transient` llegan a la política. Cualquier respuesta distinta de `{ action: 'retry' }`, o una excepción, equivale a `stop`.
- Techo duro: 10 intentos por llamada.
- Respuestas de recovery y cuarentena validadas con Zod; malformadas → incertidumbre (fail-closed).
- `inconsistency` ∈ `orphan-claim`, `orphan-measurement`, `claim-measurement-mismatch`, `fingerprint-mismatch`, `malformed-claim`, `malformed-measurement`, `unexpected-identity`.

## Recovery Mongo (`createMongoPersistenceRecovery`)

Solo lectura, `readConcern: majority`, primario. Busca claim y medición por clave natural **y** por id derivado; un documento con id inesperado ya es una inconsistencia. Valida ambos documentos con los schemas de BE13-06/BE-12. Nunca escribe.

## Placeholders productivos

`createBlockingRetryPolicy()` (siempre `stop`) y `createBlockingRetryScheduler()` (rechaza). El readiness los reporta como `BLOCKED`.

## Clasificación

Ver la tabla completa en `src/iot/ingestion-failure-classification.ts` y `ADR_BE13_08_RETRY_SEMANTICS.md`. Ejemplos:

- `transient`: `dependency-error`, `stale-*`.
- `security`: `unverified-hardware`, `realm-mismatch`, `contradictory-authority`, `attribution-drift`.
- `conflict`: `idempotency-conflict`.
- `policy-blocked`: `unresolved-clock`, `missing-reason-required`, `unresolved-persisted-at`, `inactive-device`.
- `validation`: códigos del mapper y de forma.
- `consistency`: `persistence-state-inconsistent`.
