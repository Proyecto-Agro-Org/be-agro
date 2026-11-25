# CONTRATO BE13-11C — Semántica de ACK (conceptual)

Estado: **documentación y función de decisión pura** (`decideBrokerAck`). No se implementa ACK MQTT real.

## Regla

> Un consumer futuro solo debe ACKear una entrega **después** de que el Durable Inbox la confirmó con majority + journal y validó el receipt (`status: 'persisted'` o `'ingested'` con receipt).

## Decisiones

| Resultado de la admisión | QoS 0 | QoS 1 / 2 |
|---|---|---|
| `persisted` / `ingested` | `ack-allowed` | `ack-allowed` |
| Falla transitoria (`broker-inbox-unavailable`, `broker-verifier-unavailable`) | `loss-possible-qos0` | `withhold-ack-retry` |
| Rechazo permanente (payload malformado, procedencia rechazada, etc.) | `loss-possible-qos0` | `poison-policy-undecided` |

## QoS 0

No existe redelivery. Si el inbox falla antes de persistir, el mensaje **puede perderse** y el sistema no puede evitarlo. No se finge garantía: el resultado se informa como `loss-possible-qos0`. Aceptar QoS 0 para telemetría es una decisión humana pendiente.

## QoS 1 y 2

`persist-before-ack` **reduce** la pérdida (si no se ACKea, el broker reentrega), pero **no elimina duplicados**: un redelivery posterior a una escritura ambigua genera otro registro de inbox. La idempotencia downstream por `realm+sourceId+operation+eventId+field` (BE13-06) sigue siendo obligatoria. Ni `packetId`, ni `mqttClientId`, ni el hash del payload se usan como identidad (R20, A15).

## Mensajes "veneno"

Qué hacer con un rechazo permanente en QoS 1/2 (ACKear y descartar vs. no ACKear y reentregar sin fin) **no está decidido**: `poison-policy-undecided`. Decisión humana pendiente.

## Retained

Se mantiene la política fail-closed (retained bloqueado por defecto).
