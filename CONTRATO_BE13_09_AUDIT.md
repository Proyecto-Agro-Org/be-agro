# BE13-09 — Contrato de auditoría operativa

Fuente: `src/models/ingestion-audit.models.ts`, `src/repositories/mongo-ingestion-audit.store.ts`.

## Puerto

```ts
interface IngestionAuditStore {
  append(entry: AuditAppend): Promise<{ realm; auditId; sequence }>;
  listForQuarantine(quarantineId: string, limit: number /* 1..500 */): Promise<readonly AuditRecord[]>;
  ping(): Promise<boolean>;
}
```

No existe `update` ni `delete` (verificado por V4). La colección es **append-only por contrato del código**, no por garantía del motor: **no se afirma WORM**.

## Entrada (`AuditAppend`, Zod estricto + `$jsonSchema` con `additionalProperties: false`)

| Campo | Regla |
| --- | --- |
| `realm` | realm del catálogo; debe coincidir con el realm del store (`AUDIT_REALM_MISMATCH`) |
| `quarantineId` | `q_<hex64>` o `null` |
| `eventId` | 1–256 o `null` |
| `action` | `quarantine-created`, `quarantine-recurred`, `classification-changed`, `recovery-outcome`, `replay-requested`, `replay-denied`, `replay-started`, `replay-result`, `transition-requested`, `transition-result`, `resolved`, `discarded`, `authorization-denied` |
| `actorId` | referencia segura `[A-Za-z0-9:_./-]{1,128}` |
| `actorCapabilities` | capacidades del vocabulario, únicas, máx. 8 |
| `outcome`, `reasonCode` | kebab-case `^[a-z][a-z0-9-]{1,63}$` (`reasonCode` nullable) |
| `evidence` | `{ evidenceType, reference, verification: 'DECLARED_UNVERIFIED' }` o `null` |

Asignados por el store: `_id` = `a_` + sha256(`['be13-09/audit', realm, stream, sequence]`), `stream` (= `quarantineId` o `'realm'`), `sequence`, `occurredAt` (`$$NOW` del servidor).

Rechazado por esquema (O16/O17 en Mongo real): payload crudo, `stack`, claves tipo `x-emqx-key`, sin `realm`, acción desconocida, outcome con espacios/mayúsculas, `sequence ≤ 0`.

## Orden

Clave única `(realm, stream, sequence)`. La secuencia la asigna un contador (`<prefix>_audit_sequences`, `_id = realm:stream`) incrementado en **la misma transacción** que la inserción (readConcern `snapshot`, writeConcern `majority` + `j`). Resultado: secuencia sin huecos y sin duplicados por stream, independiente de relojes (O14: 10 appends concurrentes → secuencia 1..N exacta). `occurredAt` es informativo, no define el orden.

## Índices

| Nombre | Clave | Uso |
| --- | --- | --- |
| `audit_stream_sequence` | `{realm, stream, sequence}` único | traza de una cuarentena (winning plan verificado) |
| `audit_realm_occurred` | `{realm, occurredAt}` | barridos por período (winning plan verificado) |

Sin índice TTL: ver `ADR_BE13_09_AUDIT_RETENTION.md`.

## Semántica obligatoria vs best-effort

| Momento | Semántica |
| --- | --- |
| `transition-requested`, `replay-requested`, `replay-started` | **Obligatorio (fail-closed)**: si `append` falla, excede 5 s o devuelve un recibo inválido, la acción no ocurre (`audit-unavailable`) |
| `transition-result`, `resolved`, `discarded`, `replay-result` | Best-effort; si falla se emite `AUDIT_RESULT_MISSING` |
| `authorization-denied`, `replay-denied`, `quarantine-created/recurred`, `recovery-outcome` | Best-effort; nunca alteran el resultado de la ingesta |

## Aislamiento

Cada store está atado a un realm: escribe solo ese realm y filtra lecturas por él (O15: el store `preview` no ve la traza de `test` y rechaza escribir `test`).
