# BE13-09 — Contrato de autorización de operadores

Fuente: `src/iot/ingestion-operations.contracts.ts`, `src/services/ingestion-operations.service.ts`.

## Puerto

```ts
interface OperatorAuthorizationPort {
  authorize(request: { credential: unknown; realm: TrustGateRealm; capability: OperatorCapability; quarantineId: string | null }):
    Promise<{ decision: 'allow'; principal: OperatorPrincipal } | { decision: 'deny'; reason: 'unauthenticated' | 'forbidden' | 'realm-out-of-scope' }>;
}
interface OperatorPrincipal { operatorId: string; realms: TrustGateRealm[]; capabilities: OperatorCapability[]; authenticationReference: string }
```

- La credencial es **opaca** para el servicio: nunca se leen roles, capacidades, realm ni `operatorId` desde ella ni desde la entrada de la operación.
- La respuesta del puerto se valida con Zod estricto y con tiempo acotado (5 s). Excepción, timeout o forma inválida → `deny` (`forbidden`).
- Aunque el puerto diga `allow`, el servicio exige además que `principal.realms` incluya el realm del bootstrap y que `principal.capabilities` incluya la capacidad pedida (defensa en profundidad; mutante M1).
- Por defecto: `createDenyAllOperatorAuthorization()` (placeholder registrado, readiness `BLOCKED`).

## Capacidades (vocabulario cerrado)

| Capacidad | Operación |
| --- | --- |
| `QUARANTINE_VIEW` | `view` |
| `QUARANTINE_REPLAY` | `replay`, `releaseLease` |
| `QUARANTINE_UNBLOCK` | `unblock` |
| `QUARANTINE_BLOCK` | `block` |
| `QUARANTINE_RESOLVE` | `resolve` |
| `QUARANTINE_DISCARD` | `discard` |
| `AUDIT_VIEW` | lectura de audit (reservada; sin operación expuesta) |
| `OPERATIONS_VIEW` | `operationalState` |

No hay roles en el código: el mapeo rol→capacidad pertenece al proveedor de identidad (decisión humana pendiente).

## Reglas por operación

| Operación | Origen | Destino | Evidencia aceptada | Extra |
| --- | --- | --- | --- | --- |
| `replay` | `RETRYABLE` | `REPLAYING` → `RESOLVED`/`RETRYABLE`/`BLOCKED` | — | Lease CAS; misma identidad y fingerprint |
| `unblock` | `BLOCKED`, `OPEN` | `RETRYABLE` | `policy-blocked`: `policy-approval`; otros: `dependency-restored`, `authority-restored` | Clases de seguridad/validación no admiten la transición |
| `block` | `OPEN`, `RETRYABLE` | `BLOCKED` | `operator-decision` | |
| `resolve` | `RETRYABLE` | `RESOLVED` | `data-verified` | Recovery debe informar `committed` con el mismo fingerprint |
| `discard` | `OPEN`, `RETRYABLE`, `BLOCKED` | `DISCARDED` (terminal) | `operator-decision` | |
| `releaseLease` | `REPLAYING` | `RETRYABLE` | `operator-decision` | Capacidad `QUARANTINE_REPLAY` |

Todas exigen `expectedVersion` igual a la versión actual (`stale-version` si no) y la transición en el store es CAS sobre `status` y `version`.

## Denegaciones

Resultado `{ status: 'denied', reason }` sin detalles internos. Razones (cerradas, `OperationDenial`): `invalid-request`, `unauthenticated`, `forbidden`, `realm-out-of-scope`, `evidence-required`, `evidence-type-not-accepted`, `quarantine-not-found`, `stale-version`, `transition-not-allowed`, `resolve-not-verified`, `audit-unavailable`. Si el CAS del store pierde una carrera, la operación devuelve `stale-version`. Toda denegación de autorización se audita (`authorization-denied`, best-effort) y se cuenta (`authorization_denied_total`).
