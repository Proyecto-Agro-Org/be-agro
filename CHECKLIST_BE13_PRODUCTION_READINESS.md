# BE-13 — Checklist de preparación para Production

Estado actualizado al cierre de BE13-10A (rama local, base `dev` `98dd2d8`). Decisiones pendientes: `MATRIZ_DECISIONES_HUMANAS_BE13.md`. **Nada está habilitado en runtime.** Un ítem solo se marca READY con evidencia; READY local no implica READY en Atlas.

| Ítem | Estado | Evidencia / motivo |
| --- | --- | --- |
| Realm authority | PENDING | Contrato `RealmAuthority` implementado y probado (R10–R12); falta la fuente autorizada de despliegue (configuración revisada del bootstrap) |
| Provenance verifier (EMQX) | BLOCKED | BE13-11A: contrato `BrokerProvenanceVerifier` + `BrokerIdentityMapping` y frontera MQTT offline que es dueña de la procedencia (E2E Mongo 13/13 ×2). Placeholders bloqueantes; mecanismo de autenticación, fuente de identidad, ACL, límites y retained pendientes |
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
| EMQX | BLOCKED | Sin integración ni conexión. BE13-11A define la frontera que un adapter real deberá atravesar; faltan las decisiones 18–28 de la matriz, gestión de secretos y un adapter revisado. BE13-11B: persistir antes de ingerir (inbox durable Mongo, H1 cerrado; 27/27 ×2 con majority caída y failover); faltan las decisiones 29–36 |
| Atlas | BLOCKED | No utilizado; requiere autorización, credenciales gestionadas y campaña propia |
| Monitoring | PENDING | BE13-09: puerto de métricas con 9 contadores y etiquetas de vocabulario cerrado (best-effort); snapshot operativo por conteos. Falta backend aprobado y SLO |
| Alerting | PENDING | BE13-09: puerto de alertas (hechos sin identificadores; 5 emitidas, 2 reservadas). Faltan umbrales, enrutamiento y on-call |
| Retry policy | PENDING | Mecanismo implementado (BE13-08): clasificación determinista, política y scheduler inyectables, techo duro de 10, placeholders productivos bloqueantes. Faltan los valores productivos (`maxAttempts`, backoff) |
| DLQ / quarantine store | READY (local) | BE13-08 + BE13-09: máquina de estados con lease `REPLAYING` y CAS por versión; operaciones autorizadas; probado en multi-nodo (24/24 ×2). Pendiente: reprocesamiento operado en runtime |
| Operator authorization | PENDING | BE13-09: puerto deny-by-default, 8 capacidades, realm scope, evidencia `DECLARED_UNVERIFIED`. Falta IdP, mapeo rol→capacidad y verificación de evidencia |. BE13-10A: contratos de IdP, mapeo, SoD y verificación de evidencia con placeholders bloqueantes; ningún proveedor elegido |
| Operations audit | PENDING | BE13-09: colección append-only con `$jsonSchema`, secuencia transaccional sin huecos, fail-closed en acciones administrativas. No WORM. Retención: decisión pendiente (sin TTL) |. BE13-10A: retención por stream y legal hold (sin borrado) |
| Replay lease expiry | PENDING | BE13-10B: propiedad persistida, adquisición con tiempo confiable, liberación solo del dueño, recuperación autorizada con `EXPIRED` explícito, fencing transaccional; **S7 CLOSED** (Mongo 28/28 ×2). Falta decidir la duración o el criterio y la autoridad temporal (placeholders: no hay replay) |
| Deployment | BLOCKED | Root no montado; bootstrap de operaciones offline (BE13-09) sin montar; no hay worker ni consumer |
| Rollback | PENDING | Sin procedimiento; colecciones nuevas se crean por aprovisionamiento explícito (reversible), sin migraciones de datos existentes |
| Composition root | READY (offline) | Dependencias obligatorias, placeholders bloqueantes, readiness estático; 31 pruebas |
| Aislamiento por realm | READY (local) | Realm en filtros, índices, claves y adapters; probado single-node y multi-nodo |
| HTTP / app actual | NOT_APPLICABLE | La ingesta no expone rutas; HTTP 13/13 sin cambios |

## Condiciones mínimas antes de cualquier tráfico real

1. Decisiones humanas aprobadas: clock, `declaredAt`, `missingReason`, `persistedAt`, catálogo, atestación de hardware, historial de estado de dispositivos.
2. Verifier de procedencia EMQX implementado y revisado.
3. Bootstrap revisado que inyecte solo implementaciones aprobadas (readiness sin `BLOCKED`).
4. Política de reintentos (R1), backend de monitoreo, umbrales y enrutamiento de alertas, IdP de operadores, retención del audit.
5. Campaña equivalente a BE13-06/07 contra la topología objetivo, con credenciales gestionadas fuera del repo.

## BE13-11C — Reconciliación del inbox y contrato del adapter

- [x] N4 (escritura ambigua del inbox) resuelto con reconciliación manual, claim CAS y fencing (local).
- [ ] Política de reconciliación productiva (intervalo, antigüedad, lease): decisiones 37–39. Hoy BLOCKED.
- [ ] Semántica de ACK y QoS mínimo (40, 41) y política de mensajes veneno (42).
- [ ] Registros `receipted` sin dueño (43) y tolerancia de relojes N1 (44).
- [ ] Adapter EMQX real revisado (parte del TCB); no existe todavía.
- `productionReady` permanece `false`.

## BE13-11D — EMQX local y persist-before-ack

- [x] Adapter MQTT/EMQX de laboratorio con ACK diferido verificado contra un broker real (loopback, TEST_ONLY).
- [x] Recuperación de `receipted` sin dueño (CLOSED_LOCAL) con política BLOCKED por defecto.
- [ ] Autenticación productiva, ACL y regla del broker revisadas (45, 46).
- [ ] Política de sesión, reconexión y mensajes veneno (42, 48, 49).
- [ ] Edad y ejecutor de la recuperación (37, 38, 47) y fuente de `receivedAt` (36, 44, 50).
- [ ] Revisión de la dependencia `mqtt` (52) y pruebas de carga (51).
- `productionReady` permanece `false`.

## BE13-11E — Throughput, sesiones y resiliencia del consumer

- [x] Throughput, serialización de ACK, concurrencia, sesiones y fallos medidos en laboratorio (`LOCAL_LAB_EVIDENCE`).
- [x] F-E1 y F-E3 corregidos (resultado `uncertain` irrecuperable; `start()` colgable).
- [ ] Durabilidad de sesiones del broker ante reinicio (59, F-E2 abierto).
- [ ] Requisitos de throughput, latencia y orden (53, 54, 56) y modelo de concurrencia (55, 57, 58).
- [ ] Escalado de auditoría e inbox (60, 61) y política de mensajes veneno (62).
- `productionReady` permanece `false`.
