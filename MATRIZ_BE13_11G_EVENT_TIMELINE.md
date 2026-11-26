# MATRIZ BE13-11G — Línea de tiempo por evento (`LOCAL_LAB_EVIDENCE`)

Fuente: `.local-evidence/be13-11g-event-matrix-14000-N.json` (no versionado). Pausa de secundarios: 14 000 ms.

## Corrida final (60 eventos, `BE13_11F_ONLY=G01,D13b`)
| Medida | Valor |
|---|---|
| publicados / PUBACK del publisher | 60 / 60 |
| entregados al consumer | 60 |
| neverDelivered / staleDeliveredEvents | 0 / 0 |
| recibo durable emitido | 60 (0 durante la caída) |
| ACK MQTT liberado | 60 |
| inbox tras sanar | 60 eventos con fila (62 filas en total por entregas repetidas), estado `completed:admission-processed` |
| claim / medición / cuarentena | 60 / 60 / 0 |
| eventos con recibo + ACK + inbox ausente | **0** |

Línea de tiempo (ms): before-pause t=12719 (term 1) · pause 12721 · unpause 30395 · healed 32378 (term 2) · end 35845.

## Corrida intermedia (campaña completa, 60 eventos)
PUBACK 60 · entregados 1 · `deliveries=0` en 59 · recibo 0 · ACK 0 · inbox 1 · medición 1. Los 59 no tienen recibo ni ACK: no es pérdida Mongo de eventos ya seguros.

## Corrida de 5 eventos
5/5 con recibo, ACK, inbox, claim y medición; 0 recibos durante la caída. Dos eventos con 2 entregas: la idempotencia las absorbe.

## Cómo leer la matriz
PUBACK del publisher ≠ ACK del consumer ≠ recibo durable. Sólo recibo + ACK + inbox ausente indicaría pérdida Mongo posterior a la seguridad.
