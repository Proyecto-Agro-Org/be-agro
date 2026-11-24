# BE13-05A — Matriz de vectores adversariales

Archivo: `test/be13-05a-adversarial.test.js` — **13/13** (tras corregir C1).

| V | Vector | Resultado | Severidad |
| --- | --- | --- | --- |
| V1 | Candidate fabricado, clone, spread, Proxy, prototipo, JSON | `invalid-candidate`, sin llamadas | SIN HALLAZGO |
| V2 | Inyectar ready, trusted event o resultado como entrada; exports del módulo | `invalid-candidate`; solo exporta la factory | SIN HALLAZGO |
| V3 | Omitir dependencias/políticas; realm extra; timeout inválido | `TypeError` | SIN HALLAZGO |
| V4 | Realm/tenant/clientId/fieldId en payload | ignorados | SIN HALLAZGO |
| V5 | 4 ingestas concurrentes idénticas | 1 `accepted`, 3 `duplicate` | SIN HALLAZGO |
| V6 | Colisión de eventId (payload, `sentAt`); idempotencia mentirosa | `idempotency-conflict` / `idempotency-unavailable` | SIN HALLAZGO |
| V7 | Fingerprint: metadatos de entrega excluidos; contenido declarado incluido; orden de claves canónico | según contrato | SIN HALLAZGO |
| V8 | BE-12 malicioso: evento, instante/clock, revisión | `attribution-drift` con campo | SIN HALLAZGO |
| V9 | BE-12: rechazo, conflicto, getter hostil, código desconocido, timeout | clasificados sin diagnósticos | SIN HALLAZGO |
| V10 | Política maliciosa (persistedAt) | `builder-rejected` / `contradictory-authority` | SIN HALLAZGO |
| V11 | Drift tras revalidación / después de aceptar | detectado antes de BE-12; instantánea después | RESIDUAL (C5) |
| V12 | Cruce de realm y de clientes | invisible / `realm-mismatch` / `overlapping-association` | SIN HALLAZGO |
| V13 | Alias en resultados `duplicate`/cuarentena | **falló antes**; corregido | BAJO (C1) — CORREGIDO |

## No verificable offline

| Vector | Estado |
| --- | --- |
| Código hostil en el proceso que inyecta dobles permisivos | NO VERIFICABLE — trust boundary en bootstrap |
| Store/BE-12 comprometidos que mienten de forma consistente | NO VERIFICABLE |
| Aislamiento de realm en Mongo/Atlas | NO VERIFICABLE — store Mongo pendiente |
| Atomicidad real de `claim` | NO VERIFICABLE — depende del adapter persistente |
