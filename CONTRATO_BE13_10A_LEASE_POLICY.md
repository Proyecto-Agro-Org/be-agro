# BE13-10A — Contrato de leases de replay

## Estados

| Estado | Origen |
| --- | --- |
| `ACTIVE` | almacenado; también el resultado por defecto ante cualquier duda |
| `RELEASED` | almacenado; liberado por el dueño o recuperado tras expirar |
| `EXPIRED` | **derivado**, nunca almacenado: solo si hay tiempo confiable **y** la política responde `EXPIRED` |

## Puertos

```ts
interface OperationsTimeAuthority { now({ realm }): Promise<{ realm; status: 'trusted'; at; authorityRevision } | { realm; status: 'untrusted' }> }
interface ReplayLeasePolicy { evaluate({ realm, lease, now }): Promise<{ realm; status: 'ACTIVE' | 'EXPIRED'; recoveryByNonOwner: 'never' | 'when-expired'; policyRevision }> }
interface ReplayLeaseStore {
  get(quarantineId): Promise<ReplayLease | null>;
  acquire({ quarantineId, ownerOperatorId, acquiredAt, expectedVersion }): Promise<'acquired' | 'held' | 'stale'>;
  release({ quarantineId, leaseId, expectedVersion, releasedBy, reason }): Promise<'released' | 'stale'>;
}
```

`ReplayLease = { realm, quarantineId, leaseId, ownerOperatorId, acquiredAt, state, version }`.

## Reglas del governor (`bundle.createLeaseGovernor(store)`)

1. **Propiedad**: los métodos reciben una **credencial**, no un principal. El dueño es el `subject` autenticado por el proveedor; un principal fabricado en proceso o un `operatorId` en la credencial no sirven (X4). El `leaseId` es un identificador, no un secreto.
2. **Adquirir** exige `QUARANTINE_REPLAY` (con SoD), tiempo confiable (`acquiredAt`) y CAS de versión; un lease `ACTIVE` → `lease-active`.
3. **Liberar** exige `QUARANTINE_REPLAY`, lease `ACTIVE`, `leaseId` igual y `expectedVersion` igual (CAS).
   - Dueño → `owner-release` en cualquier momento (aun sin tiempo confiable).
   - No dueño → solo con tiempo confiable, política `EXPIRED` y `recoveryByNonOwner: 'when-expired'` → `expired-recovery`.
4. **Sin takeover silencioso**: recuperar = liberar (CAS + autorización) y luego adquirir (CAS + autorización) en dos pasos explícitos. Con recuperaciones concurrentes gana exactamente una (L06).
5. Lease de otro realm o de otra entrada, lease malformado o store que falla → tratado como inexistente.
6. El dominio no lee el reloj: todo instante viene de `OperationsTimeAuthority`.

## Defaults

`leasePolicy` placeholder: siempre `ACTIVE`, `recoveryByNonOwner: 'never'` (nunca expira). `timeAuthority` placeholder: `untrusted`. Con ellos solo el dueño puede liberar y nadie puede adquirir.

## Pendiente (no decidido)

Duración del lease, si un no-dueño puede recuperar, quién (capacidad propia o `QUARANTINE_REPLAY`), autoridad temporal aprobada, persistencia en la colección de cuarentena y conexión con el replay de BE13-09 (cierra S7). Ver `ADR_BE13_10A_LEASE_EXPIRY_PENDING.md`. La ventana de 5 000 unidades de las pruebas es sintética.
