# BE13-06 — Matriz de pruebas

## Offline (`npm test`)

| Archivo | Pruebas | Resultado |
| --- | --- | --- |
| `test/be13-06-mongo-ingestion.test.js` | 15 | 15/15 |
| `test/be13-06a-adversarial.test.js` | 8 | 8/8 |
| Previas (incluye BE13-05 53/53 en modo claim y la guarda del launcher actualizada) | 664 | 664/664 |
| **Total** | **687** | **687/687** |

### `be13-06-mongo-ingestion.test.js`

| Caso | Estado |
| --- | --- |
| Realm dentro de cada filtro Mongo; opciones `maxTimeMS` y collation simple | PROBADO |
| Misma clave en dos realms no se cruza | PROBADO |
| `[validFrom, validTo)` y A→B→A (99/199/200/299/300) sobre evaluador de filtros | PROBADO |
| Ambigüedad reportada con límite 2 | PROBADO |
| Mapeo BE-11 → epoch; documentos malformados rechazados (versión negativa/fraccionaria, lifecycle, fechas inválidas, id vacío, verificación) | PROBADO |
| Consultas inválidas o con operadores inyectados rechazadas antes de Mongo | PROBADO |
| Ids deterministas, por realm, sin colisión por concatenación | PROBADO |
| Colecciones, validadores estrictos e índices únicos de clave | PROBADO |
| Composición persistente: primero `persisted:true`; retry `duplicate` con la misma referencia | PROBADO |
| Conflicto sin escritura | PROBADO |
| Drift nunca llega al store | PROBADO |
| Fallas, respuestas malformadas y realm cruzado del store → fail-closed | PROBADO |
| `persistence` obligatoria; modo claim sin cambios | PROBADO |
| Guard de destino (URI y hello) | PROBADO |
| Sin exposición en app/rutas; sin env/URIs/reloj en repositorios | PROBADO |

## Mongo real

27/27 en dos ejecuciones (ver `MATRIZ_BE13_06_MONGO_REAL.md`).

## Validaciones

`npm.cmd ci --offline` OK · typecheck OK · build OK · `npm test` 687/687 · `node scripts/verify-be10-http.mjs` 13/13 · `git diff --check` OK.
