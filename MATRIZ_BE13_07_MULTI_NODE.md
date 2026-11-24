# BE13-07 — Campaña multi-nodo local

Entorno: `scripts/be13-07-multinode-local.ps1 -AuthorizeDisposable -BasePort 27071`. Imagen oficial `mongodb/mongodb-community-server:8.0-ubi8` (**MongoDB 8.0.38**), replica set `agro_mn` de **3 miembros con voto** (prioridad igual), red bridge exclusiva con binding `127.0.0.1` y masquerade deshabilitado, contenedor *holder* que publica solo `127.0.0.1:27071-27073` y tres `mongod` que comparten su espacio de red (los miembros se llaman `127.0.0.1:<puerto>` dentro y fuera), tmpfs de 1024 MB por nodo, sin volúmenes ni privilegios, etiquetas de propiedad por `runId`, limpieza confirmada. **No es equivalente a Atlas.**

Ejecuciones finales: **2**, SHA `d3fc836`. Resultado por ejecución: **22 PASS, 2 NO VERIFICABLE, 0 FAIL**; contenedores y red eliminados en ambas.

Clasificación de evidencia: **REAL** = provocado por un evento real del servidor o la red (parada, pausa, timeout de write concern); **SIMULADO** = error inyectado; **NO VERIFICABLE** = no reproducido.

| ID | Escenario | Resultado | Evidencia |
| --- | --- | --- | --- |
| MN01 | Topología: 3 miembros, 1 primary, 2 secondaries, majority | PASS | 8.0.38; miembros `127.0.0.1:27071-27073`, todos `health:1` |
| MN-E2E | Composition root sobre Mongo multi-nodo: accepted, duplicate, conflict, cuarentena (`unresolved-device`) | PASS | +1 claim / +1 medición |
| MN02 | Transacción normal (`w: majority`, 3 nodos) | PASS | |
| MN03 | Failover: `docker stop` del primary, elección, escrituras continúan | PASS — REAL | elección 10,3 s / 10,2 s |
| MN04 | Retry exacto después del failover → `duplicate` | PASS | el claim confirmado con majority sobrevivió |
| MN05 | Conflicto después del failover | PASS | |
| MN06 | Abort antes del commit → nada persiste | PASS — SIMULADO (fallo inyectado) | |
| MN07 | Detección de huérfanos (`$lookup` en ambos sentidos) | PASS | 0 / 0 |
| MN08a / MN08 / MN09 | 2 / 4 / 10 procesos concurrentes, misma clave y fingerprint | PASS | exactamente 1 `persisted`; resto `duplicate`; segundos intentos por conflictos de escritura reales |
| MN09b | 10 procesos, fingerprints distintos | PASS | 1 `persisted`, 9 `conflict` |
| MN10 | Cross-realm: misma clave técnica, `eventId` y campo en `test` y `preview` | PASS | 2 claims independientes; `test` sigue `duplicate` |
| F01 | Failover antes del claim | PASS — REAL | 1 intento; el driver eligió el nuevo primary |
| F02 | Failover después de leer el claim | PASS — REAL TransientTransactionError | `update` → `MongoNetworkError`; `abortTransaction` → `NoSuchTransaction` [`TransientTransactionError`]; 2 intentos |
| F03 (MN13) | Failover después de insertar el claim | PASS — REAL TransientTransactionError | ídem; 2 intentos; sin claim huérfano |
| F04 | Failover después de insertar la medición, antes del commit | PASS — REAL UnknownTransactionCommitResult path | `commitTransaction` → `MongoNetworkError`; commit reintentado → `NoSuchTransaction` [`TransientTransactionError`]; transacción completa reintentada; 1 medición |
| F05 | Failover *durante* el commit (carrera) | **NO VERIFICABLE** | en ambas ejecuciones el commit terminó antes de la parada |
| MN14 | Ambigüedad de commit (secondaries pausados → `w: majority` no alcanzable) | PASS — **REAL UnknownTransactionCommitResult** | `commitTransaction` con `writeConcernError` `MaxTimeMSExpired` (50); error al llamador con etiqueta `UnknownTransactionCommitResult`; datos **confirmados** (+1/+1); retry → `duplicate` |
| MN11 | Reinicio del primary (stop + start; resincronización inicial) | PASS — REAL | |
| MN12 | Reinicio de un secondary mientras se escribe con majority | PASS — REAL | |
| MN16 | Pausa/despausa del primary (primary no responde) | PASS — REAL | elección 10,1 s / 11,4 s; retry → `duplicate` |
| F06 | Retry de todos los escenarios de falla → `duplicate`; consistencia final | PASS | 17 claims / 17 mediciones en ambas ejecuciones |
| MN-NET | Desconexión/reconexión de red de un solo miembro | **NO VERIFICABLE** | los miembros comparten el namespace de red del holder; se usó pausa (MN16) como sustituto |
| MN15 | Limpieza | PASS (launcher) | `cleanupConfirmed: true`; 0 contenedores con la etiqueta |

## Intentos de transacción por proceso (conflictos reales)

| Escenario | Ejecución 1 | Ejecución 2 |
| --- | --- | --- |
| 2 procesos | 2, 1 | 2, 1 |
| 4 procesos | 1, 2, 2, 2 | 2, 2, 2, 1 |
| 10 procesos | 1,2,2,2,2,2,2,2,2,2 | 2,2,2,1,2,2,2,2,2,2 |

## Incidencias del harness durante la campaña (corregidas)

| Incidencia | Causa | Corrección |
| --- | --- | --- |
| `OutOfDiskSpace` (14031) al crear índices | tmpfs de 512 MB < mínimo de 500 MB libres exigido por MongoDB 8.0 | tmpfs de 1024 MB (igual que BE-11), sin relajar parámetros del servidor |
| MN14 marcado como "no reproducido" | el clasificador exigía 2 commits; la especificación del driver no reintenta un commit con `MaxTimeMSExpired` | clasificación según la etiqueta que recibe el llamador; aserciones sin cambios |
| Launcher rechazaba el puerto | sockets `TIME_WAIT` de la corrida anterior | solo se rechazan puertos en estado `Listen` |
