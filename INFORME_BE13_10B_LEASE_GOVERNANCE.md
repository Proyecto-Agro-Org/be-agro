# BE13-10B — Gobernanza de leases de replay (cierre de S7)

## Resumen

BE13-10B conecta al runtime offline lo que BE13-10A había dejado como contrato:

- un lease persistido con dueño, instante confiable y token;
- adquisición y cierre por CAS;
- liberación solo del dueño;
- recuperación de leases expirados con autorización y tiempo confiable;
- fencing transaccional de la escritura final.

**S7 queda CLOSED** (ver `ADR_BE13_10B_S7_CLOSURE.md`). No se eligió duración de lease, autoridad temporal, IdP ni retención. No hay endpoints, workers ni cambios en `app.ts`.

Rama temporal `feature/be13-10b-lease-governance` desde `dev` `4b40e6de05a14949c08e284fd3c09bc141f3c029`. `main` `1bb20f76b7a739f42c75b37b9a64315276560ec1` sin cambios.

## Archivos

| Archivo | Cambio |
| --- | --- |
| `src/iot/ingestion-recovery.contracts.ts` | `QuarantineLease`, `ReplayHolder`, `acquireLease`, `settleReplay`; replay con `lease`; códigos `stale-replay-lease` y `replay-fence-unsupported` |
| `src/iot/ingestion-composition.contracts.ts` | `persistAtomically(input, { fence })`, `replayFencing: 'atomic'` |
| `src/iot/ingestion-operations.contracts.ts` | `recoverExpiredLease`; dependencias `timeAuthority` y `leasePolicy`; 6 motivos de denegación y 7 acciones de audit |
| `src/repositories/mongo-ingestion-quarantine.store.ts` | Lease en el esquema; `acquireLease` y `settleReplay` (CAS, opcionalmente dentro de una transacción); `transition` rechaza `REPLAYING` |
| `src/repositories/mongo-measurement-persistence.repository.ts` | Fence dentro de la transacción; seam `after-fence` para pruebas |
| `src/models/ingestion-quarantine.models.ts` | `lease` en `$jsonSchema` + `$expr` de coherencia; `upgradeQuarantineValidatorBe1310b` (migración local) |
| `src/models/ingestion-audit.models.ts`, `src/repositories/mongo-ingestion-audit.store.ts` | 7 acciones de lease; `upgradeAuditValidatorBe1310b` (aditiva) |
| `src/services/replay-lease-governance.ts` | Tiempo confiable y expiración fail-closed (compartido con el bundle de BE13-10A) |
| `src/services/measurement-ingestion-root.ts` | Composición con fence por replay; corte inmediato si se pierde el fence; cierre por CAS de dueño y token |
| `src/services/ingestion-operations.service.ts` | Adquisición con tiempo confiable; `releaseLease` (dueño) y `recoverExpiredLease` (`UNBLOCK`); readiness |
| `src/services/operations-security-policy.service.ts` | Reutiliza los esquemas compartidos de tiempo y decisión de lease |
| `scripts/audit-be13-10b-multinode-local.ts`, `scripts/be13-07-multinode-local.ps1` | Campaña `-Suite be13-10b` |

## Migración (local)

El orden es:

1. Desplegar el código, que lee y escribe `lease`.
2. Ejecutar `upgradeQuarantineValidatorBe1310b` y `upgradeAuditValidatorBe1310b`.
3. Correr las pruebas.
4. Revisar los datos existentes.

Los documentos de BE13-08/09 sin `lease` siguen siendo válidos en todos los estados salvo `REPLAYING`. Si hay entradas `REPLAYING` sin dueño, la migración responde `blocked` con la cantidad y **no cambia nada**. Resolverlas es una decisión explícita del operador. Se probó en Mongo real (B-MIG). No se escribió nada contra Atlas.

Compatibilidad: el pedido menciona `BLOCKED_BY_POLICY`, pero ese estado no existe. Lo representa `BLOCKED` con `retryClass: 'policy-blocked'`, que sigue siendo válido.

## Hallazgos

| ID | Severidad | Hallazgo | Corrección |
| --- | --- | --- | --- |
| H1 | MEDIO | `version` no sirve como fencing token: `record()` la incrementa en cada recurrencia, aunque la entrada esté en `REPLAYING` | Token dedicado: la versión en el instante de adquirir |
| H2 | MEDIO | El replay de BE13-08 (sin lease) también podía escribir una medición de una entrada descartada mientras corría | Fence sin lease: CAS `RETRYABLE` → `RESOLVED` dentro de la transacción |
| H3 | MEDIO | Un adaptador de persistencia que ignora `options` anularía el fence sin que nadie lo note | Declaración obligatoria `replayFencing: 'atomic'`; sin ella el replay se rechaza |
| H4 | BAJO | Un replay que perdió el lease y encontró `duplicate` se informaba como `done` | Se informa `stale-replay-lease` cuando no escribió bajo su propio lease |
| H5 | BAJO (preexistente) | La campaña BE13-08 no se había vuelto a correr después de BE13-09: Q09 y Q22 no conocían `version` | Expectativas actualizadas; regresión 25/25 |

## Riesgos residuales

- **Bypass en proceso.** Código con acceso directo al store puede llamar `settleReplay` con un dueño y token que lea del documento. El token no es un secreto; la frontera sigue siendo el bootstrap.
- **Un lease huérfano** solo se recupera con una política que declare `EXPIRED`. Con los placeholders, nunca se recupera. Además, sin tiempo confiable no se puede adquirir un lease.
- **El reloj de la autoridad temporal** es inyectado y no está decidido. La expiración solo es tan confiable como esa autoridad.
- **La recuperación devuelve la entrada a `RETRYABLE`** y no hace replay. Un replay posterior o un discard son pasos manuales.
- **Docker local no equivale a Atlas.**

## Estado

| Categoría | Elementos |
| --- | --- |
| IMPLEMENTADO | Propiedad, adquisición con tiempo confiable, liberación por el dueño, recuperación autorizada, fencing transaccional, validator, migración local, audit, readiness |
| PROBADO | 859/859 offline (34 nuevas); Mongo 28/28 × 2; regresión BE13-09 24/24 y BE13-08 25/25; 6/6 mutantes; HTTP 13/13 |
| CERRADO | S7 |
| PENDIENTE (decisión humana) | Duración del lease, autoridad temporal, IdP, mapeo, SoD, retención |
| BLOCKED | EMQX, Atlas, hardware |
