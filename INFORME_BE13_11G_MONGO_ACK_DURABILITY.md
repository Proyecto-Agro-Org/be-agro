# INFORME BE13-11G — Durabilidad Mongo antes del ACK MQTT (F-F7)

Estado: `LOCAL_LAB_EVIDENCE`. `productionReady=false`. Alcance: sólo F-F7 / Mongo. F-E2 (EMQX) no se reabre.

## Pregunta
¿Se pierden en Mongo eventos que ya tenían recibo durable y ACK MQTT cuando no hay majority más allá del timeout de elección (term 1→2)?

## Cambio de causalidad (obligatorio)
- **ANTES (informe 11F):** "59 eventos ACKeados se perdieron en Mongo".
- **RESULTADO 11G:** esa lectura no está respaldada por la evidencia de 11G. Publisher PUBACK ≠ consumer ACK ≠ recibo durable. Una corrida intermedia mostró 59 eventos que pudieron recibir PUBACK de EMQX por el publisher, pero **sin** recibo durable y **sin** ACK MQTT del consumer, y que no fueron reentregados después del restart/recuperación de sesión (limitación broker/sesión de 11F). Ningún evento de 11G tiene recibo + ACK + inbox ausente.

## Evidencia (matriz por eventId en `MATRIZ_BE13_11G_EVENT_TIMELINE.md`)
| Corrida | publicados | PUBACK | entregados | neverDelivered | stale | recibo | ACK | inbox tras sanar | medición |
|---|---|---|---|---|---|---|---|---|---|
| 5 eventos, 14 s (sondeo 1) | 5 | 5 | 5 | n/d | n/d | 5 | 5 | 5 | 5 |
| 60 eventos, campaña completa (sondeo 2) | 60 | 60 | 1 | 59* | n/d | 0 | 0 | 1 | 1 |
| **60 eventos, final (G01+D13b)** | 60 | 60 | 60 | **0** | **0** | **60** | **60** | **60** | **60** |

\* derivado de `deliveries=0`; los contadores `neverDelivered` y `staleDeliveredEvents` se agregaron después de esa corrida.

La corrida final **no reprodujo** la no-entrega: los 60 eventos se entregaron y procesaron. Recibos durante la caída: 0 (el recibo sólo se emite tras majority). La elección se confirmó (term 1→2). Hipótesis, sin probar: la no-entrega de la corrida intermedia dependía del estado de sesión dejado por escenarios previos de la campaña completa (familia D04); la corrida final aisló G01+D13b.

## G01 (hallazgo válido, permanece)
Con los secundarios pausados, un claim `w:1` existe sólo en el primario: lectura local = visible, lectura majority = ausente. El pre-check leía en `local` y podía responder `duplicate` para un evento cuya escritura luego se revierte. Fix `525d8c4`: el pre-check (sin sesión) lee con `readConcern: majority` y ahora lo trata como ausente (`preCheck: absent`). Dentro de una transacción la lectura ya es consistente con su propio commit majority.

## Veredicto
**F-F7 = REFUTED / MISCLASSIFIED** como "pérdida Mongo de un evento ya seguro": no existe ningún evento con recibo + ACK + inbox ausente. La no-entrega observada se asocia a la limitación broker/sesión de 11F, no a Mongo. El fix de G01 se mantiene como endurecimiento.

## Límites de esta conclusión
- No existe una corrida de D13b previa al fix con matriz por evento. No se puede afirmar qué parte del síntoma original de 11F explicaba el pre-check `local`: esa causa era plausible (G01 demuestra que es posible) pero no quedó demostrada como la del síntoma.
- Una sola corrida final, sin repeticiones adicionales, por el tope de alcance de 11G.
- Si apareciera recibo + ACK + inbox ausente, F-F7 pasa a `OPEN_LOCAL`.

## Guardas offline
`test/be13-11g-ack-after-majority.test.js` G1–G4: pre-check con majority; "presente" sólo si la lectura majority lo devuelve; recibo del inbox con escritura majority+journal y relectura majority; ACK sólo desde un recibo persistido.
