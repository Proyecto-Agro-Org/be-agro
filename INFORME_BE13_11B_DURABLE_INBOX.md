# BE13-11B — Durable Broker Inbox y persistir antes de ingerir

## Resumen

Cierra **H1** de BE13-11A. El instante persistido que exige BE13-04 ahora solo existe si se cumplen estas condiciones, en orden:

1. La procedencia fue VERIFIED.
2. Los bytes exactos se escribieron en el Durable Broker Inbox de MongoDB, con majority + journal.
3. El store asignó el instante (`$$NOW` del servidor) y emitió un receipt después de una relectura majority.
4. El procesamiento se hizo **desde el registro persistido**.

Nadie puede declarar `rawPersistedAt`. Todo es offline: sin EMQX, sin MQTT, sin worker, sin cambios en `app.ts` y sin elegir el mecanismo de autenticación.

Rama temporal `feature/be13-11b-durable-broker-inbox` desde `dev` `9719ae6f1d16b7b61590b8ae1589747d4db49161`. `main` `1bb20f76b7a739f42c75b37b9a64315276560ec1` sin cambios.

Decisión: `ADR_BE13_11B_PERSIST_BEFORE_INGEST.md`. Contratos: `CONTRATO_BE13_11B_DURABLE_INBOX.md`, `CONTRATO_BE13_11B_PERSISTED_RECEIPT.md`, `CONTRATO_BE13_11B_RECOVERY.md`.

## Archivos

| Archivo | Rol |
| --- | --- |
| `src/iot/broker-fingerprints.ts` | sha256 del payload, `contextFingerprint` y `provenanceFingerprint` compartidos |
| `src/models/broker-inbox.models.ts` | colección, `$jsonSchema` cerrado, índice `inbox_realm_persisted`, aprovisionamiento (sin TTL) |
| `src/repositories/mongo-broker-inbox.store.ts` | store insert-only (majority + j, `$$NOW`, relectura majority) |
| `src/services/mqtt-ingestion-boundary.service.ts` | núcleo compartido; `createMqttIngestionBoundary` (directo, no durable); `createDurableBrokerAdmissionService` (`admit`, `processPersistedBrokerDelivery`, `admitForReplay`); `describeDurableAdmissionReadiness` |
| `src/iot/mqtt-ingestion-boundary.contracts.ts` | sin `rawPersistedAt` observado; contratos de inbox, receipt y admisión |
| `src/iot/ingestion-failure-classification.ts`, observabilidad, audit | 3 códigos, 3 métricas, 3 alertas, 5 acciones de audit; `upgradeAuditValidatorBe1311b` (aditiva) |
| `src/adapters/ingestion-production-placeholders.ts` | `durableInbox` bloqueante dentro del objeto de placeholders del boundary |
| `scripts/audit-be13-11b-multinode-local.ts` | campaña I01–I27 (`-Suite be13-11b`) |
| `scripts/audit-be13-11a-multinode-local.ts` | el camino aceptado ahora pasa por el inbox Mongo; E10 usa el camino directo |

## Estado de los hallazgos de BE13-11A

| ID | Estado | Evidencia |
| --- | --- | --- |
| **H1** `persistedAt` sin fuente durable | **CLOSED** | Se cumplen los seis criterios: el instante sale solo del inbox (D06, I06); el boundary rechaza un `rawPersistedAt` declarado (D07, A02, I07; mutante M2); E2E aceptado desde un receipt real (D10, I10); crash recovery (D11, I11) con failover (I27); sin procesamiento si la escritura falla (D17, I18; mutante M5); campaña Mongo 27/27 × 2 |
| H2 colisión de `measurementId` en el doble | Mantenido | D25: IDs sha256, 3 eventos dan 3 mediciones |
| H3 rechazos de seguridad sin cuarentena | Mantenido y ampliado | D26, I02–I04: sin cuarentena **y sin inbox** |

## Hallazgos nuevos

| ID | Severidad | Hallazgo | Estado |
| --- | --- | --- | --- |
| N1 | MEDIO | Si el reloj del adapter (`receivedAt`) va adelantado respecto del servidor Mongo (`rawPersistedAt`), el mapper rechaza por `invalid-timestamp`. Apareció en las pruebas con el reloj sintético del inbox en memoria | Fail-closed; documentado. La sincronización de relojes y la autoridad temporal quedan como decisión pendiente |
| N2 | MEDIO | `admitForReplay` no recomputaba el `provenanceFingerprint`: un registro con la procedencia alterada producía evidencia de replay (lo detectó A06) | CORREGIDO: un único camino de integridad (`loadVerifiedRecord`) para recuperación y replay |
| N3 | BAJO | La campaña BE13-11A dependía de `rawPersistedAt` observado | Actualizada: el camino aceptado pasa por el inbox Mongo; regresión 13/13 |
| N4 | MEDIO | Escritura no confirmada (sin majority, I18): no se procesa, pero al recuperarse la majority el registro **quedó** en el inbox sin receipt (huérfano, 1 en la corrida 2) | Residual documentado: no se procesa solo (no hay worker); la reconciliación es una decisión pendiente; el índice `inbox_realm_persisted` permite inspeccionarlo |

## Riesgos residuales

- **Los fingerprints no son MAC:** quien pueda reescribir un registro completo de forma consistente en la base de datos no es detectado. Requiere control de cuentas o WORM (decisión pendiente).
- **No se revalida la procedencia** al recuperar; la revocación retroactiva es una decisión pendiente.
- **Registros huérfanos (N4)** y procesamiento duplicado en recuperaciones concurrentes: una sola medición, pero con costo de CPU y E/S.
- **Volumen y retención del inbox** sin decidir; el payload crudo puede contener datos sensibles.
- **Docker local no equivale a Atlas;** no hay broker real.

## Estado

| Categoría | Elementos |
| --- | --- |
| IMPLEMENTADO | Inbox insert-only, admisión durable (2 modos), recuperación y replay desde registro, integridad, audit, métricas, alertas, readiness, placeholders |
| PROBADO | 934/934 offline (37 nuevas); Mongo 27/27 × 2 con majority caída y failover reales; regresiones BE13-11A 13/13 y BE13-10B 28/28; 6/6 mutantes; HTTP 13/13 |
| CERRADO | H1 |
| PENDIENTE (decisión humana) | Retención del inbox, privacidad del payload, revocación, programación de la recuperación, worker, backlog máximo, dimensionamiento, reloj |
| BLOCKED | EMQX, Atlas, hardware |

> **Actualización BE13-11C:** N4 quedó **CERRADO** para la topología local probada (ver `INFORME_BE13_11C_INBOX_RECONCILIATION.md`). La reconciliación es manual, bloqueada por política por defecto, sin worker.
