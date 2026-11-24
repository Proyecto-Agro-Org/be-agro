# BE13-08 — Contrato de cuarentena y replay

## Store (`createMongoIngestionQuarantineStore({ connection, prefix, realm })`)

| Operación | Comportamiento |
| --- | --- |
| `record(entry)` | upsert por `quarantineId` (dedupe); en la creación fija estado inicial, `firstSeenAt` y `createdAt` (`$$NOW`); siempre incrementa `attemptCount`, actualiza `lastSeenAt` y `updatedAt` y agrega auditoría `recorded`. Escritura `w: majority, j: true` |
| `get(id)` | lectura `majority` filtrada por `_id` **y** `realm`; documento validado |
| `transition({ quarantineId, from, to, evidence, outcome })` | máquina de estados + actualización condicionada a `status: from`; `BLOCKED → RETRYABLE` exige evidencia; devuelve `transitioned`, `not-allowed`, `not-found` o `stale` |
| `appendAudit(id, entry)` | agrega entrada acotada (máximo 100, se conservan las últimas) |

## Documento (`<prefix>_quarantine`)

| Campo | Tipo |
| --- | --- |
| `_id` | `q_` + hex64 (quarantineId) |
| `realm` | enum |
| `stage` | `mapper`, `trust-gate`, `builder`, `be12`, `composition`, `persistence`, `recovery`, `retry` |
| `sourceId`, `eventId`, `field` | string 1..256 o `null` |
| `operation` | `measurement`, `device-status` o `null` |
| `device` | `{ kind, value }` o `null` |
| `reasonCode` | kebab-case (no vacío) |
| `cause` | kebab-case o `null` |
| `retryClass` | enum de clases |
| `fingerprint`, `documentDigest` | hex64 o `null` |
| `status` | `OPEN`, `RETRYABLE`, `BLOCKED`, `RESOLVED`, `DISCARDED` |
| `attemptCount` | entero ≥ 1 |
| `firstSeenAt`, `lastSeenAt`, `createdAt`, `updatedAt` | date (hora técnica del servidor) |
| `audit` | ≤ 100 × `{ action: recorded\|transition\|replay, at: date, outcome: kebab, reasonCode, evidence: [A-Za-z0-9:_./-]{1,256} \| null }` |

`additionalProperties: false`: no se admite ningún otro campo (payload, stack, mensajes, secretos). Verificado contra Mongo real (Q22).

## Índices

| Nombre | Campos | Único | Propósito |
| --- | --- | --- | --- |
| `_id_` | `_id` | sí | dedupe y lookup puntual (`FETCH > IXSCAN _id_`) |
| `quarantine_realm_status` | realm, status, updatedAt | no | listar o escanear por estado dentro de un realm |
| `quarantine_realm_event` | realm, eventId | no | todas las entradas de un evento en un realm |

## Replay

`root.replay({ quarantineId, protectedDocument, provenanceEvidence, field })` → `replayed` (con el resultado del pipeline y el estado final) o `replay-rejected` con `quarantine-not-found`, `replay-not-allowed`, `replay-identity-mismatch`, `replay-fingerprint-mismatch` o `invalid-replay-input`. Requiere estado `RETRYABLE`, la misma identidad técnica y el mismo fingerprint; nunca es automático. Replays concurrentes: como máximo una medición (la atomicidad de BE13-06 decide); el resto obtiene `duplicate` confirmado.
