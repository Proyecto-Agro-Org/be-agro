# INFORME BE13-11H — Reproducción de la no-entrega de D13b según el historial de sesión

Estado: `LOCAL_LAB_EVIDENCE`. `productionReady=false`. Alcance: sólo si la no-entrega histórica de D13b depende del estado de sesión dejado por escenarios previos. No se tocó Mongo, el fix de 11G, el adapter productivo ni la configuración del broker.

## Resultado
**`REPRODUCED_LOCAL`** — secuencia mínima **D13 → D13b**, 3 de 3 repeticiones, mismo patrón en cada una. D13b aislado (variante A, evidencia de 11G) entrega 60/60.

## Secuencia original relevante (BE13-11F, grupo durable-tuned)
D03, D04, D05, D06, D07, D19, D09, D09b, D20, D21, D11, D12, G01, **D13**, **D13b**. El síntoma (1 procesado, 59 nunca entregados) apareció en la campaña completa; D13 es el único escenario anterior que deja eventos propios en la sesión durable con el mismo `clientId`.

## Variantes ejecutadas (máx. 4 / 3 repeticiones / 2 minimizaciones)
| Variante | Secuencia | Reps | Resultado |
|---|---|---|---|
| A | D13b aislado | 1 (11G, reutilizada: el código de D13b no cambió salvo el snapshot) | 60/60 entregados, `neverDelivered=0`, `stale=0` |
| B | D13 → D13b | 3 | **3/3**: `neverDelivered=59`, `stale=60`, 1 procesado |
| C, D | — | 0 | no necesarias: B reproduce de forma consistente (regla de detención) |
| Minimización | — | 0 | B ya es una secuencia de un solo escenario previo |

## Contadores de D13b (iguales en B-r1, B-r2, B-r3)
| Contador | Valor |
|---|---|
| publicados | 60 |
| PUBACK del publisher | 60 |
| entregados (de los 60 propios) | 1 |
| neverDelivered | 59 |
| staleDeliveredEvents | **60**, todos de D13 (`staleByScenario: {d13: 60}`) |
| recibos durables de eventos propios | 0 |
| ACK MQTT de eventos propios | 0 |
| eventos con recibo + ACK + inbox ausente | 0 |
| claims / mediciones propias | 1 / 1 |
| cuarentena | 0 |
| reinicios del supervisor | 4 |
| term de Mongo | 1 → 2 |

## Snapshot de sesión antes de D13b (idéntico en las 3 repeticiones)
`clientId=lab-consumer-durable` · `sessionPresent=true` · `cleanStart=false` solicitado · `sessionExpiry=3600` solicitado · suscripción durable `agro/lab/verified` QoS 1 · reinicios del broker hasta ese momento: 1 · aperturas de consumer raw: 2 · arranques del adapter: 2 · escenarios previos: D13. Los campos `inflight_cnt`, `mqueue_len`, `clean_start` y `expiry_interval` **no se capturaron** en estas corridas: el snapshot truncaba la respuesta de `GET /clients/{id}` (HTTP 200) a 900 caracteres antes de parsearla, por lo que quedaron vacíos. Es una limitación del arnés, no una propiedad del broker; se corrigió el parseo en este commit pero **no se repitieron las corridas** por el presupuesto de 11H. Inflight y cola offline quedan, por tanto, sin observar. La suscripción sí aparece con `durable: true`.

## Qué deja D13 y qué se observa
Tras el restart y la pausa de Mongo de D13b, el broker reentrega primero los **60 eventos de D13**, ya procesados en D13 (stale). El adapter los persiste, los ACKea y los resuelve como `duplicate` (60 recibos de eventos stale; no son eventos de D13b). Los 59 eventos propios de D13b no llegan dentro de la ventana observada (4 reinicios del supervisor, esperas acotadas); sólo 1 se entrega y procesa. No hay recibo ni ACK de esos 59, por lo que **no hay pérdida Mongo**: publisher PUBACK ≠ entrega al consumer ≠ recibo durable.

Observación acotada a la ventana del arnés: no se sabe si esos 59 se habrían entregado más tarde.

## Hipótesis (sólo H1–H5)
| H | Hipótesis | Evidencia | Estado |
|---|---|---|---|
| H1 | cursor/inflight de la sesión previa | los 60 de D13 vuelven antes que los nuevos; inflight no capturado | compatible, no demostrada |
| H2 | `sessionPresent` inconsistente | `sessionPresent=true` en las 3 repeticiones | sin apoyo |
| H3 | `clientId` estable reutilizando estado previo | el `clientId` es el mismo en D13 y D13b; D13b aislado usa el mismo `clientId` pero con sesión nueva y no reproduce: lo que importa es el estado acumulado de esa sesión, no el id en sí | compatible |
| H4 | checkpoint de la sesión durable atrasado | D13 ACKeó y procesó los 60, y aun así el broker los reentrega tras el restart: el progreso ACKeado no quedó persistido | **hipótesis principal**, no demostrada |
| H5 | stale redelivery desplaza entregas nuevas | `stale=60` frente a `delivered=1` de 60 propios, 3/3 | **observada**; la causa (H4) no está aislada |

No se aisló H4 de H1 ni de H5 (haría falta capturar inflight/cola, variar configuración o mirar el almacenamiento durable, fuera del alcance).

## Relación con F-E2
Es la misma familia que D04: el estado inflight/ACK de la sesión durable no sobrevive a un restart con fidelidad y la reentrega stale desplaza a lo nuevo. F-E2 sigue `BLOCKED_BY_BROKER_CAPABILITY`; D13b queda como `KNOWN_LIMITATION` dependiente del historial. No se intentó arreglar EMQX ni se cambió configuración (heartbeat, flush, expiry, receiveMaximum, write buffer).

## Correcciones a 11G
11G documentó que la no-entrega "no se reprodujo" en la corrida aislada. 11H la reproduce con un único escenario previo: la hipótesis de 11G (dependencia del estado previo de sesión) queda **confirmada**. El veredicto de F-F7 no cambia: sigue sin existir ningún evento con recibo + ACK + inbox ausente.

## Límites
- Variante A basada en una sola corrida (11G).
- C y D no se ejecutaron; no se sabe si otros escenarios previos (D11, D12) también reproducen.
- Qué parte exacta del estado de sesión causa el efecto (H4 vs. H1) queda abierta.
