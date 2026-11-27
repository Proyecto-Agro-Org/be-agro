# MATRIZ BE13-11I — Orden de entrega D13 → D13b (`LOCAL_LAB_EVIDENCE`)

Fuente: `.local-evidence/be13-11i-R1.json` y `be13-11i-R2.json` (no versionados; contienen la matriz completa por eventId, el payload TEST_ONLY de los snapshots y todos los paquetes). `orden` = posición de primera entrega en D13b. R1 y R2 son idénticos fila a fila salvo los instantes absolutos. Los eventos con atributos idénticos se agrupan.

## R1

| eventIds | origen | PUBACK | entregado | orden | primera entrega (ms) | paquetes | DUP | recibo | ACK consumer | resolución duplicado / inbox | medición | clasificación final |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| d13-0 … d13-59 salvo d13-32 (59) | D13 | true | true | 2…61 | 65904…77092 | 1 | [true] | true | true | completed:admission-processed + completed:admission-processed / 2 | true | STALE_REDELIVERED_ACKED |
| d13-32 | D13 | true | true | 34…34 | 75592…75592 | 2 | [false,true] | true | true | completed:admission-processed + completed:admission-processed + completed:admission-processed + completed:admission-processed / 4 | true | STALE_REDELIVERED_ACKED |
| d13b-0 | D13b | true | true | 1…1 | 56380…56380 | 1 | [false] | false | false | completed:recovered-and-processed / 1 | true | OWN_DELIVERED_NOT_ACKED |
| d13b-1 … d13b-59 (59) | D13b | true | false | — | — | 0 | null | false | false | — / 0 | false | OWN_NEVER_DELIVERED |

## R2

| eventIds | origen | PUBACK | entregado | orden | primera entrega (ms) | paquetes | DUP | recibo | ACK consumer | resolución duplicado / inbox | medición | clasificación final |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| d13-0 … d13-59 salvo d13-32 (59) | D13 | true | true | 2…61 | 60459…71567 | 1 | [true] | true | true | completed:admission-processed + completed:admission-processed / 2 | true | STALE_REDELIVERED_ACKED |
| d13-32 | D13 | true | true | 34…34 | 70235…70235 | 2 | [false,true] | true | true | completed:admission-processed + completed:admission-processed + completed:admission-processed + completed:admission-processed / 4 | true | STALE_REDELIVERED_ACKED |
| d13b-0 | D13b | true | true | 1…1 | 50930…50930 | 1 | [false] | false | false | completed:recovered-and-processed / 1 | true | OWN_DELIVERED_NOT_ACKED |
| d13b-1 … d13b-59 (59) | D13b | true | false | — | — | 0 | null | false | false | — / 0 | false | OWN_NEVER_DELIVERED |

## Lectura
- D13: 60/60 entregados de nuevo en D13b (stale), con recibo y ACK; `d13-32` aparece dos veces (primera copia `DUP=0`, segunda `DUP=1`); resolución `completed:admission-processed` (duplicado).
- D13b: sólo `d13b-0` se entrega (primero, `DUP=0`, sin ACK por falta de mayoría Mongo; se resolvió por reconciliación `recovered-and-processed`). `d13b-1…59`: `OWN_NEVER_DELIVERED` incluso tras drenar los stale y una ventana extendida de 150 s (R2).
- Recibo+ACK+inbox ausente: 0. Cuarentena: 0.
