# CONTRATO BE13-11D — Adapter MQTT/EMQX (laboratorio local)

Código: `src/adapters/emqx-mqtt-broker.adapter.ts`, `src/adapters/emqx-mqtt-connect.ts`. **Laboratorio**: no se monta en `app.ts`, no es un worker productivo, rechaza cualquier broker que no sea loopback.

## API

`createEmqxMqttBrokerAdapter({ brokerUrl, clientId, username, password, mqttFactory, metrics?, clock?, sessionExpirySeconds?, poisonPolicy?, testHooks? })` → `{ start(handler), stop(), stats(), connectionReference(), lastBrokerReceivedAt() }`.

El `handler(delivery)` recibe un `AdapterObservedDelivery` y devuelve un `AckDecision` (BE13-11C). Es el consumidor quien persiste en el Durable Inbox; el adapter solo traduce la decisión en ACK o no-ACK.

## Guards (antes de crear cualquier cliente)

| Guard | Rechaza |
|---|---|
| `assertLoopbackBrokerUrl` | cualquier esquema ≠ `mqtt:`; `localhost` y cualquier nombre DNS; IPs no loopback (10.x, 192.168.x, 0.0.0.0); userinfo en la URL; puertos < 1024 o ausentes; rutas; `mongodb+srv`, dominios públicos o de nube |
| `assertLabCredentialShape` | usuarios inválidos y contraseñas que no sean del formato generado `labpw-<hex>` (≥ 16 caracteres): una contraseña con forma de real no pasa |

## Hechos que produce (únicamente observados)

`connectionReference` (nonce por arranque), `authenticatedPrincipalReference` (`emqx-user:` + username autenticado), `mqttClientId`, `topic`, `qos`, `retain`, `packetId` (solo QoS > 0), `receivedAt` (reloj del adapter) y los bytes exactos.

## Lo que NUNCA produce

realm, clientId de negocio, sourceId, ownership, `trusted`, `verified`, identidad de hardware, `rawPersistedAt`. El envelope del broker es cerrado: cualquier clave extra (`realm`, `trusted`, `rawPersistedAt`, `authenticated`…) lo hace *poison*. Esos campos tampoco existen en el `BrokerDeliveryContext` del boundary.

## Envelope del broker (esquema cerrado)

`{ clientid, username, qos, topic, retain, publish_received_at, payload_b64 }`. Se valida: `username` y `clientid` con patrón restringido, `qos` ∈ {0,1,2} **igual** al QoS de la entrega, base64 **canónico** (se recodifica y se compara), UTF-8 válido del envelope. Un mensaje que no cumpla se trata como *poison* y nunca se interpreta como hechos.

## Configuración del cliente

MQTT **5** forzado (`customHandleAcks` se ignora en MQTT 3.1.1), `clean: false`, `sessionExpiryInterval` TEST_ONLY, `reconnectPeriod: 0`, suscripción a `agro/lab/verified` con QoS 2.

## Métricas

`broker_adapter_connection_total` (`connected`, `disconnected`) y `broker_adapter_delivery_total` (`received`, `acked`, `withheld`, `dropped`, `rejected`). Labels cerrados; sin usernames ni client ids.

## Readiness

`describeEmqxLocalLabReadiness(...)` → `emqxLocalLabReady` (solo laboratorio) y `productionReady: false` literal.

## Límites conocidos

- La librería serializa las entregas por conexión mientras el handler no resuelve.
- No hay reconexión automática ni gestión de sesiones múltiples (un solo `clientId` de consumer por laboratorio).
- El adapter + la regla del broker + la ACL son TCB.
