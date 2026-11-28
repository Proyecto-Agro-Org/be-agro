# BE13-10B — Contrato de propiedad de leases de replay

Fuentes: `src/iot/ingestion-recovery.contracts.ts`, `src/repositories/mongo-ingestion-quarantine.store.ts`, `src/services/ingestion-operations.service.ts`, `src/services/replay-lease-governance.ts`.

## Campo persistido

```ts
interface QuarantineLease { ownerId: string; acquiredAt: number; token: number } // en Mongo: acquiredAt es BSON date
```

| Campo | Origen | Nunca proviene de |
| --- | --- | --- |
| `ownerId` | `OperatorPrincipal.operatorId` devuelto por el `OperatorAuthorizationPort` | request, payload, credencial, headers |
| `acquiredAt` | `OperationsTimeAuthority.now()` con respuesta `trusted`, validada estrictamente y del mismo realm | caller, `Date.now()` del dominio |
| `token` | versión resultante de la CAS de adquisición | aleatoriedad, caller |

`lease` existe **si y solo si** `status === 'REPLAYING'`. Lo exigen el `$expr` del validator Mongo y el esquema Zod de lectura.

## Operaciones

| Operación | Capacidad | Requisitos | Resultado |
| --- | --- | --- | --- |
| `replay` (adquiere) | `QUARANTINE_REPLAY` | `RETRYABLE`, `expectedVersion`, tiempo confiable, audit `replay-requested` obligatorio | CAS `RETRYABLE(v)` → `REPLAYING` + lease; audit `lease-acquired`; `replay-started` obligatorio (si falla, el lease se devuelve) |
| `releaseLease` | `QUARANTINE_REPLAY` | `REPLAYING`, `expectedVersion`, `lease.ownerId === principal.operatorId`, evidencia `operator-decision`, audit `lease-release-requested` obligatorio | CAS → `RETRYABLE`; audit `lease-released-owner` |
| `recoverExpiredLease` | `QUARANTINE_UNBLOCK` | `REPLAYING`, `expectedVersion`, tiempo confiable, `EXPIRED` explícito con `recoveryByNonOwner: 'when-expired'`, evidencia `operator-decision`, audit `lease-recovery-requested` obligatorio | CAS → `RETRYABLE`; audit `lease-recovered-expired` |
| `discard` | `QUARANTINE_DISCARD` | origen `OPEN`, `RETRYABLE` o `BLOCKED`; **nunca `REPLAYING`** | — |

Las denegaciones de lease se auditan como `lease-release-denied`, con el motivo en `outcome`.

## Vocabulario de denegación (nuevo)

`time-authority-unavailable`, `lease-owned-by-another-operator`, `lease-active`, `lease-policy-unavailable`, `stale-replay-lease`, `replay-fence-unsupported`.

## Expiración (fail-closed)

`evaluateReplayLeaseExpiry` devuelve `EXPIRED` **solo** si se cumplen todas estas condiciones:

- el tiempo es confiable y bien formado, para el mismo realm;
- la política responde `EXPIRED`, bien formada y para el mismo realm;
- la política indica `recoveryByNonOwner: 'when-expired'`.

En cualquier otro caso devuelve `ACTIVE`, con una base: `time-untrusted`, `policy-unavailable`, `policy-active` o `recovery-not-allowed`. Una excepción, un timeout (5 s), un getter hostil, campos extra o un estado desconocido también cuentan como `ACTIVE`.

**No se fija duración.** La ventana de 1 000 unidades sintéticas de las pruebas es `TEST_ONLY`.

## Dependencias del bootstrap

`timeAuthority` y `leasePolicy` son obligatorias. La readiness las reporta como `MISSING`, `BLOCKED` (placeholders de `createBlockingSecurityPolicies`) o `INJECTED_UNVERIFIED`. `operationsTestReady` las incluye; `productionReady` es el literal `false`. Se agregan las limitaciones `LEASE_DURATION_PENDING` y `TIME_AUTHORITY_PENDING`.
