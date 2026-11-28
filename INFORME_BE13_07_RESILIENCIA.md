# BE13-07 — Resiliencia multi-nodo y composition root

## Resumen

- **Resiliencia:** el store transaccional de BE13-06 se probó contra un replica set local de **3 nodos MongoDB 8.0.38** con failover, reinicios, pausas, concurrencia multiproceso y ambigüedad de commit. Dos ejecuciones finales: 22 PASS, 2 NO VERIFICABLE, 0 FAIL cada una. Detalle: `MATRIZ_BE13_07_MULTI_NODE.md`.
- **Composition root:** `createMeasurementIngestionRoot`, única factory de alto nivel para BE13-02 → BE13-06, con dependencias obligatorias, placeholders productivos bloqueantes y diagnóstico estático. No montado en `app.ts`. Detalle: `CONTRATO_BE13_07_COMPOSITION_ROOT.md`.

Rama `feature/be13-07-resilience-composition-root`, worktree `.local-consolidacion/be13-07`, base `origin/dev` `81f25adc0f81966f35c6836bc35c7ebfa94e9012` (merge de BE13-06, PR #26).

## Archivos

| Archivo | Rol |
| --- | --- |
| `src/services/measurement-ingestion-root.ts` | Composition root + `describeIngestionRootReadiness` |
| `src/iot/ingestion-root.contracts.ts` | Contratos: realm authority, BE-12 authorities, reconocimiento de historial, readiness |
| `src/adapters/ingestion-production-placeholders.ts` | Placeholders productivos bloqueantes (registrados para diagnóstico) |
| `src/repositories/mongo-measurement-persistence.repository.ts` | Nuevo punto de inyección de prueba `after-read` (F02); sin cambio de comportamiento |
| `scripts/be13-07-multinode-local.ps1` | Launcher desechable de 3 nodos (holder + nodos) |
| `scripts/be13-07/{guard,connect,worker}.ts` | Guard de destino y de propiedad, conexión, worker concurrente |
| `scripts/audit-be13-07-multinode-local.ts` | Campaña MN/F |
| `test/be13-07-*.test.js` | 22 root + 9 adversariales + 3 guard multi-nodo |

## Topología y guard

Los tres miembros comparten el espacio de red de un contenedor *holder* que publica solo `127.0.0.1:27071-27073`, así que el driver del host y los miembros usan los mismos nombres `127.0.0.1:<puerto>`. El guard exige: contexto Docker local, contenedores y red con la etiqueta del `runId`, imagen oficial 8.0, sin privilegios ni binds, tmpfs, `--replSet agro_mn` y puerto esperado por nodo, red bridge con binding loopback y sin masquerade, URI con exactamente los tres hosts loopback, `replicaSet=agro_mn`, sin `+srv`, credenciales, TLS ni `directConnection`, y `hello` con miembros solo loopback. El caos se limita a `stop | start | pause | unpause` sobre los nodos propios.

## Resultados clave

- **Failover:** elecciones de ~10–11 s (timeout de elección por defecto). Escrituras posteriores correctas; el claim confirmado con majority sobrevivió (retry → `duplicate`).
- **TransientTransactionError — REAL:** al perder el primary en mitad de la transacción (F02, F03) el driver vio `MongoNetworkError` y `NoSuchTransaction` [`TransientTransactionError`] y reintentó la transacción completa: 2 intentos, exactamente 1 medición, sin huérfanos.
- **UnknownTransactionCommitResult — REAL:**
  - F04: error de red en `commitTransaction`, reintento del commit, `NoSuchTransaction` y reintento completo.
  - MN14: con los secondaries pausados, el commit devolvió `writeConcernError` `MaxTimeMSExpired`; según la especificación del driver no hay reintento automático en ese caso y el llamador recibió `UnknownTransactionCommitResult`. **Los datos quedaron confirmados** y el reintento idempotente devolvió `duplicate`.
- **Concurrencia multi-nodo:** 2/4/10 procesos → 1 medición; fingerprints distintos → 1 + 9 `conflict`.
- **Cross-realm:** claves independientes por realm.
- **Huérfanos:** ninguno en ninguna ejecución (17/17 al final).

## Hallazgo de diseño

**R1 (MEDIO):** ante un commit ambiguo, `persistAtomically` propaga el error y la composición responde `persistence-unavailable`, aunque la medición puede estar confirmada. Es fail-closed y no duplica (MN14 lo prueba), pero el llamador no puede distinguir "no escrito" de "escrito sin confirmación". No se "resuelve" devolviendo `persisted`: no es posible distinguir el commit propio de uno concurrente con el mismo contenido. **Condición para runtime:** la política de reintentos debe reintentar ante `persistence-unavailable` con la misma entrada; el resultado convergerá a `duplicate`.

## NO VERIFICABLE

- F05: parada del primary exactamente durante el commit (carrera no reproducida en 2 ejecuciones; la ambigüedad de commit sí se reprodujo por otros caminos).
- Desconexión de red de un solo miembro (namespace compartido); sustituida por pausa.
- Comportamiento en Atlas (red real, versiones gestionadas, elecciones, latencias).

## Limitaciones

- Docker local en una sola máquina; tmpfs: un miembro detenido vuelve vacío y se resincroniza.
- Autoridades y políticas sintéticas en las pruebas positivas.
- `DEVICE_STATUS_HISTORY_REQUIRED` sigue BLOQUEADO.

## Estado

| Categoría | Elementos |
| --- | --- |
| IMPLEMENTADO | Composition root, placeholders, readiness, launcher/guard/campaña multi-nodo |
| PROBADO | Offline 721/721; multi-nodo 22 PASS ×2; HTTP 13/13 |
| PENDIENTE | Política de reintentos del runtime (R1), monitoreo, alertas, DLQ, bootstrap productivo |
| BLOQUEADO | Políticas productivas, verifier de procedencia, atestación de hardware, catálogo, historial de dispositivo, EMQX, Atlas |
| NO VERIFICABLE | F05, desconexión individual de red, Atlas |
