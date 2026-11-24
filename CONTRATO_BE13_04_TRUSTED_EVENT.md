# BE13-04 — Contrato `trusted-event`

## Estado

IMPLEMENTADO y PROBADO offline con dobles explícitos. No compuesto en `app.ts`, sin rutas, sin persistencia, sin MongoDB/Atlas/EMQX/hardware. Ninguna política está aprobada: todas bloquean por defecto.

## Entrada

```ts
createTrustedEventBuilder({ revalidators, policies? }, { realm, authorityTimeoutMs? })
  .build(candidate: ProtectedMeasurementCandidate, ready: ReadyForAttribution): Promise<TrustedEventResult>
```

- `candidate`: objeto emitido por el mapper BE13-02 (`isIssuedProtectedCandidate`).
- `ready`: objeto emitido por el gate BE13-03 **para ese mismo candidate** (`isIssuedReadyFor(ready, candidate)`, WeakMap privado del módulo del gate; no existe export para registrar). Copias, clones, Proxy, prototipos, readies de otra instancia del módulo o de otro candidate → `invalid-ready`.
- Ambos registros son **procedencia dentro del mismo proceso**, no autenticación.
- `realm` del builder debe coincidir con `ready.realm`.
- Opciones estrictas: no existe `skipRevalidation` ni equivalente.

## Revalidadores (obligatorios)

Mismos contratos que las autoridades BE13-03 (`DeviceRevalidator = DeviceResolutionPort`, etc.). Las consultas se reconstruyen con `src/iot/trust-gate.queries.ts`, el mismo módulo que usa el gate; el caller nunca suministra respuestas. Faltante → `TypeError` en construcción.

Para cada autoridad se exige **revisión igual Y fingerprint igual** (fingerprint recalculado sobre la respuesta actual canonicalizada):

| Autoridad | Comparación | Fallo |
| --- | --- | --- |
| Dispositivo | `fingerprints.device`, 1 dispositivo, `id`, `version = revisions.deviceVersion` | `stale-device` |
| Hardware | `fingerprints.hardware`, `verified`, `attestationRevision` | `stale-hardware` |
| Temporal | `fingerprints.temporal`, `trusted`, `policyRevision`, `at`, `clock` | `stale-temporal-policy` |
| Asociación | `fingerprints.association`, 1 registro, `id`, `revision`, `clientId` | `stale-association` |
| Catálogo | `fingerprints.catalogue`, `approved`, `catalogueRevision`, magnitud, unidad | `stale-catalog` |

**Realm isolation is an adapter/storage responsibility:** el realm forma parte obligatoria de cada consulta y la respuesta debe declararlo; los registros BE-11 no lo contienen y su ausencia no se interpreta como compatibilidad.

## Políticas (opcionales; por defecto bloquean)

| Política | Se consulta | Aprobación válida | Fallo |
| --- | --- | --- | --- |
| `ClockPolicy` | siempre | `received-at` solo si el reloj BE13-03 es `received-at` y `authorizedAt = receivedAt`; `declared-at-approved` solo si el reloj BE13-03 es declarado, la fuente de `declaredAt` es la misma y `declaredAt = authorizedAt` | bloqueada → `unresolved-clock`; inconsistente → `contradictory-authority` |
| `DeclaredAtPolicy` | siempre | `source` ∈ `device-timestamp` (valor = `deviceTimestamp` numérico exacto), `broker-sent-at` (= `sentAt` exacto), `none` (= `null`) | bloqueada → `unapproved-declared-at`; reloj de dispositivo no numérico → `missing-declared-at`; valor distinto → `contradictory-authority` |
| `MissingReasonPolicy` | solo si `value === null` | valor del enum BE-12 | bloqueada → `missing-reason-required`; respuesta inválida → `invalid-missing-reason` |
| `PersistenceTimePolicy` | solo si el candidate tiene `persistedAt` | `persistedAt` igual al del candidate y `≥ receivedAt` | `persistedAt` nulo o bloqueada → `unresolved-persisted-at`; otro valor → `contradictory-authority` |

Un número (incluido `0`) lleva `missingReason: null` sin consultar política. Un campo ausente nunca llega a BE13-04 (`absent-field` en BE13-03). Ningún valor se completa con `Date.now()`, `receivedAt`, `sentAt` ni `authorizedAt`.

## Resultado `trusted-event`

```ts
{
  status: 'trusted-event',
  event: TrustedMeasurementEvent,          // exactamente uno, parseado por trustedMeasurementEventSchema (BE-12)
  attribution: { realm, authorizedAt, clock, physicalDeviceId, clientId, fieldId, areaId, sensorId,
                 associationId, associationRevision },   // valores que BE-12 debe reproducir; NO es AttributionResult
  policies: { clock, declaredAt, declaredAtSource, missingReason, persistenceTime },  // revisiones de políticas
  revisions, fingerprints,                 // iguales a las del ready
  revalidation: 'required'                 // BE-12 resolve() vuelve a leer sus puertos
}
```

`event`: `eventId`, `sourceId`, `device`, `receivedAt`, `declaredAt`, `persistedAt`, `magnitude`, `unit`, `value`, `missingReason`, `provenance` (= origen verificado por hardware: `physical`/`simulated`), `simulated` (= `provenance === 'simulated'`), `metadata: {}` (no se trasladan metadatos sin contrato). Sin `clientId`.

Todo el resultado está congelado en profundidad y no comparte objetos con el candidate, el ready ni las consultas.

## Resultado `quarantined`

`{ status: 'quarantined', reason, eventId: string | null }` sin mensajes, stacks ni payload.

Códigos: `invalid-candidate`, `invalid-ready`, `realm-mismatch`, `stale-device`, `stale-association`, `stale-temporal-policy`, `stale-catalog`, `stale-hardware`, `unresolved-clock`, `unapproved-declared-at`, `missing-declared-at`, `missing-reason-required`, `invalid-missing-reason`, `unresolved-persisted-at`, `schema-mismatch`, `contradictory-authority`, `invalid-authority-response`, `dependency-error`, `internal-error`.

## Orden

Procedencia → realm → revalidación (dispositivo, hardware, temporal, asociación, catálogo) → clock → declaredAt → consistencia temporal → missingReason → persistedAt → schema BE-12 → resultado. El primer fallo detiene el flujo.
