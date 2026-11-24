# BE13-10A — Contrato de retención del audit y legal hold

## Puertos

```ts
type AuditRetentionDecision =
  | { mode: 'pending-decision' }
  | { mode: 'retain-indefinitely'; approvalReference }
  | { mode: 'retain-until'; until: number; approvalReference };
interface AuditRetentionAuthority { policyFor({ realm, stream }): Promise<{ realm; policy: AuditRetentionDecision; policyRevision }> }
interface LegalHoldAuthority { holdFor({ realm, stream }): Promise<{ realm; stream; legalHold: boolean; holdReference: string | null }> }
```

Relación con BE13-09: `AuditRetentionPolicy` (BE13-09) es la declaración estática del bootstrap y no cambia. `AuditRetentionAuthority` decide por stream.

## Evaluación (`bundle.evaluateRetention({ stream })`)

Resultado: `{ outcome: 'RETAIN' | 'ELIGIBLE_FOR_DELETION_REVIEW', basis, deletes: false }`.

| Orden | Condición | Resultado |
| --- | --- | --- |
| 1 | entrada inválida | `RETAIN` / `invalid-request` |
| 2 | legal hold desconocido (falla, malformado, otro stream o realm) | `RETAIN` / `legal-hold-unknown` |
| 3 | `legalHold: true` | `RETAIN` / `legal-hold` (gana sobre cualquier retención) |
| 4 | política no disponible o malformada | `RETAIN` / `retention-unavailable` |
| 5 | `pending-decision` | `RETAIN` |
| 6 | `retain-indefinitely` | `RETAIN` |
| 7 | `retain-until` sin tiempo confiable | `RETAIN` / `time-untrusted` |
| 8 | `retain-until` con `now ≤ until` | `RETAIN` / `retain-until-not-reached` |
| 9 | `retain-until` con `now > until` | `ELIGIBLE_FOR_DELETION_REVIEW` |

## Garantías

- **No hay borrado**: ni TTL, ni método de borrado, ni proceso automático. `ELIGIBLE_FOR_DELETION_REVIEW` solo habilita una revisión humana futura (proceso no definido).
- `deletes` es el literal `false`.
- Defaults: retención `pending-decision`; legal hold placeholder **activo** (`true`).

## WORM

No se provee ni se afirma. Un audit inmutable requiere controles externos (almacenamiento con retención bloqueada, cuentas sin privilegios de escritura, export firmado por un tercero). Mongo estándar con un store sin métodos de update/delete **no es WORM**.

## Pendiente

Plazos por tipo de acción o realm, proceso y titulares de legal hold, revisión de borrado, archivado/exportación, WORM. Ver `ADR_BE13_10A_RETENTION_PENDING.md`.
