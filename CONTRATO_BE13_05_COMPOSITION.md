# BE13-05 — Contrato de composición de ingesta

## Estado

IMPLEMENTADO y PROBADO offline con dobles sintéticos. **No compuesto en runtime**: sin cambios en `app.ts`, sin rutas, consumer MQTT, worker, cron, listener ni cola. No persiste mediciones.

## Composition root

```ts
createMeasurementIngestionComposition({
  realmContext: { realm },           // realm autorizado; nunca del payload
  identityStore,                     // IngestionIdentityStore (lectura, realm obligatorio)
  temporal, hardware, catalogue,     // autoridades BE13-03
  policies: { clock, declaredAt, missingReason, persistenceTime },   // BE13-04
  idempotency,                       // MeasurementIdempotencyPort
  be12,                              // servicio BE-12 con resolve()
  authorityTimeoutMs?,               // 1–60000, provisional
}).ingest(candidate, { field })
```

Todas las dependencias son obligatorias: faltante o inválida → `TypeError` al construir. No hay defaults permisivos. Gate y builder se construyen internamente con el mismo realm y los mismos adapters.

## Flujo

1. `candidate` emitido por BE13-02 (`isIssuedProtectedCandidate`); si no → `invalid-candidate`. La composición no acepta readies ni eventos como entrada.
2. Clave de idempotencia y fingerprint técnico; `lookup` (solo lectura): mismo fingerprint → `duplicate` sin ejecutar el resto; distinto → `idempotency-conflict`.
3. Trust gate BE13-03 → si no `ready` → `trust-gate-rejected` (`cause` = código del gate).
4. Builder BE13-04 → si no `trusted-event` → `builder-rejected` (`cause` = código del builder).
5. BE-12 `resolve()` sobre una copia defensiva del evento.
6. Reconciliación A1 (ver abajo).
7. `claim` atómico (último paso): `claimed` → `accepted`; `replay` → `duplicate`; `conflict` → `idempotency-conflict`.

## Reconciliación A1 (BE13-04 vs BE-12)

Se exige igualdad exacta de: realm, evento completo (incluye `eventId`, `sourceId`, `device`, tiempos, magnitud, unidad, valor, `missingReason`, procedencia), `physicalDeviceId`, `clientId`, `fieldId`, `areaId`, `sensorId`, `associationId`, `associationRevision`, `attributedAt = authorizedAt` y `clock`. Diferencia → `attribution-drift` con `cause` = primer campo divergente (o `realm-mismatch`). BE-12 no fue modificado.

## Idempotencia

- Clave: `realm + sourceId + operation + eventId + field` (una medición lógica por evento y campo del payload).
- Fingerprint técnico (`src/iot/ingestion-event-fingerprint.ts`), SHA-256 de JSON canónico (claves ordenadas recursivamente) con exactamente: versión, realm, `sourceId`, `storeOperation`, `operation`, `eventId`, `device {kind,value}`, `field`, payload técnico completo, `deviceTimestamp` y `sentAt`. Excluye lo volátil por entrega: `receivedAt`, `persistedAt`, topic, identidad de broker, flags de procedencia y todo valor derivado de autoridades.
- Retry de transporte (mismo contenido, otra recepción) → `duplicate`. Duplicado semántico con contenido distinto → `idempotency-conflict`. No hay exactly-once.
- `claim` debe ser atómico en el adapter. Adapter por defecto: bloqueante (`idempotency-unavailable`). El fake en memoria vive solo en `test-support/`.

## Identity store y adapters

`IngestionIdentityStore` (`findDevicesByKey`, `findAssociationsAt`) con realm en cada consulta y en cada fila. `createIngestionIdentityPorts` (BE13-03/04) y `createBe12IdentityPorts` (BE-12) aplican el realm del contexto, rechazan consultas de otro realm y detectan filas filtradas de otro realm (→ `realm-mismatch` en BE13, error en BE-12). **El aislamiento por realm en almacenamiento es responsabilidad de la implementación del store.**

## Resultados

```ts
| { status: 'accepted', event: TrustedMeasurementEvent, attribution, idempotency: { key, fingerprint }, persisted: false }
| { status: 'duplicate', eventId, idempotency: { key, fingerprint } }
| { status: 'quarantined', reason, cause: string | null, eventId: string | null }
```

Congelados en profundidad, sin referencias compartidas con el candidate ni con objetos entregados a dependencias.

Códigos: `invalid-candidate`, `invalid-selection`, `trust-gate-rejected`, `builder-rejected`, `be12-rejected`, `realm-mismatch`, `attribution-drift`, `idempotency-conflict`, `idempotency-unavailable`, `dependency-error`, `internal-error`. `cause` es siempre un código cerrado de etapa o nombre de campo; nunca un mensaje.

## Contratos de seguridad

- TypeScript no es frontera de seguridad.
- WeakSet/WeakMap (candidate, ready) son procedencia dentro del proceso, no autenticación.
- Políticas y autoridades inyectables no son autenticación.
- Los adapters confiables los elige la composición; **el trust boundary productivo es el bootstrap/composition root**, que todavía no existe.
- BE13-05 no elimina TOCTOU: no hay transacción única entre gate, builder, BE-12 y claim.
