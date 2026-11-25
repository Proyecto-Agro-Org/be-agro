# ADR BE13-11D — Persist-before-ACK con MQTT.js y EMQX

Estado: aceptado para el laboratorio local. Fecha: 2026-11-25.

## Contexto

Para no perder lecturas, un consumer MQTT solo debe confirmar (PUBACK/PUBREC) una entrega cuando el Durable Inbox la confirmó con majority + journal. Eso exige controlar **cuándo** el cliente envía el ACK. Verificado en el código real de MQTT.js 5.16.1 (`build/lib/handlers/publish.js`) y contra EMQX 5.8.6:

| Hecho | Evidencia |
|---|---|
| El PUBACK de QoS 1 y el PUBREC de QoS 2 se envían **solo después** de que `customHandleAcks(topic, message, packet, callback)` invoque su callback. | Lectura del código; E04 (orden `persist → acked → processed`). |
| `customHandleAcks` **solo se respeta con `protocolVersion: 5`**. Con MQTT 3.1.1 la librería lo reemplaza **en silencio** por un ACK automático. | `client.js` líneas 150–154. |
| Si no se envía ACK y se corta la conexión, EMQX conserva el mensaje en la sesión y lo **reentrega** (`dup: true`) al reconectar con el mismo `clientId` y `clean: false`. | Probe aislado y E18/E19. |
| QoS 0 no tiene ACK ni reentrega. | E13. |
| Un `customHandleAcks` pendiente serializa las entregas de esa conexión (backpressure). | Lectura del código (pump). |

## Decisión

1. El adapter **fuerza MQTT 5** (`protocolVersion: 5`, `clean: false`, expiración de sesión TEST_ONLY, `reconnectPeriod: 0`). Una prueba (D05) falla si alguien cambia la versión.
2. La entrega se persiste (`admit` en modo `persist-only`) **antes** de liberar el ACK. El procesamiento del pipeline ocurre **después** del ACK, desde el registro persistido (QoS 1/2) o inmediatamente (QoS 0).
3. Ante cualquier fallo transitorio (inbox, verifier, excepción del handler) **no se ACKea y se cierra la conexión**: el broker reentrega al reconectar. No se responde con un reason code de error porque en MQTT 5 un PUBACK ≥ 0x80 da la entrega por terminada.
4. Rechazos permanentes (mensaje inválido, principal desconocido): política de **laboratorio** `ack-and-drop` explícita y contada, o `withhold`. La política productiva sigue pendiente.
5. La reconexión automática de la librería está desactivada: reconectar es responsabilidad del arnés (un proceso nuevo, con nueva `connectionReference`).

## Qué NO se garantiza

- QoS 0: puede perderse (demostrado, E13).
- Duplicados: persist-before-ack los reduce pero no los elimina; la idempotencia de negocio es la defensa final.
- Una escritura ambigua del inbox seguida de reentrega puede dejar un registro huérfano: lo cubre la reconciliación de BE13-11C.
- No se evaluó rendimiento: la serialización por conexión limita el throughput de un consumer.

## Estado

`ACK_CONTROL = AVAILABLE` para MQTT.js 5.16.1 **con MQTT 5**. No se implementó protocolo MQTT propio.
