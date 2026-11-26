# MATRIZ BE13-11H — Secuencias ejecutadas (`LOCAL_LAB_EVIDENCE`)

Fuente: `.local-evidence/be13-11h-<variante>.json` (no versionado). Config histórica sin cambios: durable-tuned (`flush_interval=1 ms`, `max_items=1`), pausa de Mongo de 14 s, 60 eventos, `clientId` estable, `sessionExpiry=3600`.

| Variante | Secuencia | Rep | publicados | PUBACK | entregados | neverDelivered | stale | recibos propios | ACK propios | inbox propio | mediciones | sessionPresent | Estado |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | D13b aislado (11G) | 1 | 60 | 60 | 60 | 0 | 0 | 60 | 60 | 60 | 60 | true | no reproduce |
| B-r1 | D13 → D13b | 1 | 60 | 60 | 1 | 59 | 60 (d13) | 0 | 0 | 1 | 1 | true | **reproduce** |
| B-r2 | D13 → D13b | 2 | 60 | 60 | 1 | 59 | 60 (d13) | 0 | 0 | 1 | 1 | true | **reproduce** |
| B-r3 | D13 → D13b | 3 | 60 | 60 | 1 | 59 | 60 (d13) | 0 | 0 | 1 | 1 | true | **reproduce** |
| C | — | 0 | | | | | | | | | | | no ejecutada (B consistente) |
| D | — | 0 | | | | | | | | | | | no ejecutada |

## Contadores de sesión antes de D13b (B, idénticos en las 3 reps)
`clientId=lab-consumer-durable` · reinicios del broker: 1 · aperturas raw: 2 · arranques del adapter: 2 · conexiones registradas por la métrica: 2 · escenarios previos: D13.

## Lectura
- Recibo + ACK + inbox ausente: 0 en todas las corridas (no hay problema Mongo nuevo).
- Reproducción 3/3: `REPRODUCED_LOCAL`, secuencia mínima D13 → D13b.
- Los 60 eventos stale de D13 se reentregan, se persisten, se ACKean y se resuelven `duplicate`; los 59 eventos propios no llegan dentro de la ventana del arnés (4 reinicios del supervisor).
- Presupuesto usado: 2 variantes (A reutilizada, B), 3 repeticiones, 0 minimizaciones, 1 suite final.
