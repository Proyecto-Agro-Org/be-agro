# BE-13 — Checklist de preparación para Production

Estado actualizado al cierre de BE13-08 (rama local, base `dev` `8bd99f4`). **Nada está habilitado en runtime.** Un ítem solo se marca READY con evidencia; READY local no implica READY en Atlas.

| Ítem | Estado | Evidencia / motivo |
| --- | --- | --- |
| Realm authority | PENDING | Contrato `RealmAuthority` implementado y probado (R10–R12); falta la fuente autorizada de despliegue (configuración revisada del bootstrap) |
| Provenance verifier (EMQX) | BLOCKED | Placeholder bloqueante; no existe verifier de broker aprobado |
| Hardware attestation | BLOCKED | Placeholder bloqueante; método de atestación no decidido |
| Clock policy | BLOCKED | Decisión humana pendiente; placeholder bloqueante |
| declaredAt policy | BLOCKED | Decisión humana pendiente |
| missingReason policy | BLOCKED | Decisión humana pendiente |
| persistedAt policy | BLOCKED | Decisión humana pendiente |
| Catálogo de magnitudes/unidades | BLOCKED | Catálogo BE-04 final no aprobado como autoridad versionada |
| Device status history | BLOCKED | `DEVICE_STATUS_HISTORY_REQUIRED`; hoy fail-closed con estado actual |
| Mongo topology | PENDING | Replica set local de 3 nodos probado (22 PASS ×2); falta la topología objetivo (Atlas o equivalente) y su validación |
| Transaction resilience | PENDING | Failover, reintento transitorio, commit ambiguo y concurrencia probados localmente (REAL). **R1 resuelto en BE13-08** con recovery majority (25/25 × 2, Q05 REAL). F05 y Atlas NO VERIFICABLES |
| Idempotencia / atomicidad | READY (local) | BE13-06: claim + medición en una transacción; 29/29 ×2 single-node; multi-nodo consistente; pendiente revalidar en la topología objetivo |
| Secrets management | PENDING | Ningún secreto en el repo; no existe aún mecanismo de credenciales para Atlas/EMQX |
| EMQX | BLOCKED | Sin integración, sin verifier, sin autorización |
| Atlas | BLOCKED | No utilizado; requiere autorización, credenciales gestionadas y campaña propia |
| Monitoring | PENDING | Sin métricas de ingesta (cuarentenas por código, latencia, reintentos) |
| Alerting | PENDING | Sin alertas definidas |
| Retry policy | PENDING | Mecanismo implementado (BE13-08): clasificación determinista, política y scheduler inyectables, techo duro de 10, placeholders productivos bloqueantes. Faltan los valores productivos (`maxAttempts`, backoff) |
| DLQ / quarantine store | READY (local) | BE13-08: cuarentena Mongo sanitizada con dedupe, máquina de estados, auditoría y replay explícito; probada en multi-nodo. Pendiente: autorización de operadores, retención de auditoría, reprocesamiento operado |
| Deployment | BLOCKED | Root no montado; no hay bootstrap, worker ni consumer |
| Rollback | PENDING | Sin procedimiento; colecciones nuevas se crean por aprovisionamiento explícito (reversible), sin migraciones de datos existentes |
| Composition root | READY (offline) | Dependencias obligatorias, placeholders bloqueantes, readiness estático; 31 pruebas |
| Aislamiento por realm | READY (local) | Realm en filtros, índices, claves y adapters; probado single-node y multi-nodo |
| HTTP / app actual | NOT_APPLICABLE | La ingesta no expone rutas; HTTP 13/13 sin cambios |

## Condiciones mínimas antes de cualquier tráfico real

1. Decisiones humanas aprobadas: clock, `declaredAt`, `missingReason`, `persistedAt`, catálogo, atestación de hardware, historial de estado de dispositivos.
2. Verifier de procedencia EMQX implementado y revisado.
3. Bootstrap revisado que inyecte solo implementaciones aprobadas (readiness sin `BLOCKED`).
4. Política de reintentos (R1), monitoreo, alertas y almacenamiento de cuarentenas.
5. Campaña equivalente a BE13-06/07 contra la topología objetivo, con credenciales gestionadas fuera del repo.
