# CONTRATO BE13-11D — ACK real (laboratorio)

Complementa `CONTRATO_BE13_11C_ACK_SEMANTICS.md` con el comportamiento **observado** contra EMQX 5.8.6 + MQTT.js 5.16.1.

## Secuencia garantizada (QoS 1)

1. EMQX entrega el mensaje; MQTT.js invoca `customHandleAcks` y **no envía PUBACK**.
2. El handler verifica procedencia, resuelve identidad y escribe el registro en el Durable Inbox (`w: majority`, `j: true`), relee con `readConcern: majority` y marca `receipted`.
3. Recién entonces se invoca el callback ⇒ PUBACK.
4. Después del ACK se procesa el pipeline desde el registro persistido y se completa el estado.

Evidencia: orden `persist → acked → processed` (E04), kill antes de persistir/antes del ACK ⇒ redelivery (E18/E19), kill después del ACK ⇒ sin redelivery y recuperación por inbox (E20/E21).

## Qué ocurre si algo falla

| Situación | Resultado |
|---|---|
| Inbox/verifier no disponible, excepción del handler | **Sin ACK + conexión cerrada** ⇒ EMQX reentrega al reconectar la sesión. |
| Proceso muerto antes de persistir | Sin registro, sin ACK ⇒ reentrega ⇒ una medición (E18). |
| Proceso muerto con registro durable, antes del ACK | Reentrega ⇒ dos registros de inbox, una medición (E19). |
| Proceso muerto después del ACK, antes de la medición | El broker **no reentrega**; el registro `receipted` queda sin dueño ⇒ recuperación por política (E20/E21). |
| Rechazo permanente | Laboratorio: `ack-and-drop` (contado) o `withhold`. Producción: pendiente (decisión 42). |
| Pérdida de majority en Mongo | Sin ACK; reentrega; posible registro huérfano (N4) resuelto por reconciliación (E33/E34). |
| Failover de Mongo | En E25 la entrega esperó la elección y se ACKeó con receipt majority (resultado real, no forzado). |

## QoS

| QoS | ACK controlado | Garantía |
|---|---|---|
| 0 | No existe | Puede perderse si el inbox falla (demostrado, E13). |
| 1 | Sí (PUBACK diferido) | Persist-before-ack; duplicados posibles. |
| 2 | Sí (PUBREC diferido) | Smoke OK (E31); no reemplaza la idempotencia de negocio. |

## Advertencias

- Con MQTT 3.1.1 la librería ACKearía automáticamente: por eso el adapter fuerza MQTT 5.
- Un PUBACK con reason code de error **no** pide reentrega en MQTT 5; por eso un fallo se maneja cortando la conexión.
- No se evaluó rendimiento ni límites de inflight.
