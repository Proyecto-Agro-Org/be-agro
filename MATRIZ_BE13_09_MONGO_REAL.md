# BE13-09 — Campaña Mongo real (local, desechable)

Replica set local de 3 nodos (`agro_mn`), MongoDB **8.0.38**, Docker, puertos `127.0.0.1:27071-27073`, tmpfs. Lanzador: `scripts/be13-07-multinode-local.ps1 -AuthorizeDisposable -BasePort 27071 -Suite be13-09` (exige árbol limpio; **no compila**: ejecutar `npm run build` antes). Autoridades y operador sintéticos. Sin Atlas, sin EMQX, sin hardware, sin secretos.

## Corridas

| Corrida | SHA | Resultado | Limpieza |
| --- | --- | --- | --- |
| 1 | `239367f` | FAIL en O04 (aserción de la campaña; `dist` desactualizado en la 2) | contenedores eliminados |
| 2 | `39bf308` | FAIL en O04 (`dist` sin recompilar) | contenedores eliminados |
| 3 | `40fbff5` | **24/24 PASS** | `cleanupConfirmed: true` |
| 4 | `40fbff5` | **24/24 PASS** | `cleanupConfirmed: true` |

Evidencia: `.local-evidence/be13-09-multinode.json` (ignorado por git), `auditCount 58`, `quarantineCount 9`.

## Escenarios

| ID | Escenario | Resultado |
| --- | --- | --- |
| O01 | Replay sin credencial válida y con credencial sin capacidad | denegado; sin medición nueva |
| O02 | Replay autorizado | `done`, `RESOLVED`, +1 medición |
| O03 | Operador de otro realm | `realm-out-of-scope` |
| O04 | Traza del replay | exacta: `quarantine-created`, 3× `authorization-denied`, `replay-requested`, `replay-started`, `replay-result`; secuencia 1..7 |
| O05 | Denegaciones auditadas | ≥ 2 `authorization-denied` |
| O06 | Resolve autorizado | sin medición → `resolve-not-verified`; con medición confirmada → `RESOLVED` + 1 `resolved` |
| O07 | Resolve sin capacidad | `forbidden` |
| O08 | Discard autorizado | `DISCARDED` |
| O09 | Transiciones inválidas | unblock de DISCARDED y de BLOCKED por seguridad → `transition-not-allowed` |
| O10 | Versión vieja | servicio `stale-version`; store Mongo CAS directo → `stale`; estado intacto |
| O11 | 2 replays concurrentes | 1 `done` + 1 `denied`; +1 medición |
| O12 | 3 resolves concurrentes | exactamente 1 `done` |
| O13 | Replay vs discard concurrentes | exactamente un ganador (en ambas corridas: replay, `RESOLVED`); nunca medición para `DISCARDED` |
| O14 | Secuencia de audit | sin huecos ni duplicados, también con 10 appends concurrentes |
| O15 | Aislamiento de audit por realm | store `preview` no lee `test` y rechaza escribirlo |
| O16 | `$jsonSchema` rechaza payload crudo | error 121 |
| O17 | `$jsonSchema` rechaza `stack`, `x-emqx-key`, sin realm, acción/outcome inválidos, `sequence` 0/−1; acepta un documento válido | verificado |
| O18 | Audit caído bloquea acción administrativa | `audit-unavailable`; sigue `RETRYABLE` |
| O19 | Métricas emitidas con etiquetas acotadas | sin ids en etiquetas |
| O20 | Métricas que lanzan y alertas que no responden | resultado `accepted` intacto |
| O21 | Alertas | `RETRY_EXHAUSTED`, sin identificadores |
| O22 | Snapshot desde Mongo | denegado sin credencial; conteos `{RETRYABLE 2, BLOCKED 1, RESOLVED 5, DISCARDED 1}`, `auditHealthy`, `productionReady: false`, sin ids |
| O-IDX | Planes de consulta | `audit_stream_sequence` y `audit_realm_occurred` como winning plan |
| O23 | Limpieza | confirmada por el lanzador |
