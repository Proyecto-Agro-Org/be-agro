# ADR BE13-11D — Autenticación y origen de la identidad en el laboratorio EMQX local

Estado: **LOCAL_TEST_ONLY**. **No** selecciona la autenticación productiva (`PRODUCTION AUTH = PENDING`).

## Decisión de laboratorio

Usuario/contraseña del autenticador `built_in_database` de EMQX 5.8.6, con credenciales generadas por cada corrida (`labpw-` + 128 bits aleatorios), mantenidas solo en memoria, no commiteadas, no reutilizadas y destruidas con el contenedor. Motivo: simplicidad, reproducibilidad, aislamiento y cero dependencia externa.

## Problema: un suscriptor no ve quién publicó

Un cliente MQTT que consume mensajes **no recibe** el username ni el clientid del publisher. Si el adapter tomara la identidad del payload, del topic o de su propia sesión, sería spoofeable. Solución verificada contra EMQX real:

1. Los publishers publican en `agro/lab/in/<x>`; la ACL (deny por defecto) limita qué topics puede usar cada principal.
2. Una **regla del motor de reglas de EMQX** reenvía cada publicación a `agro/lab/verified` con un envelope JSON **generado por el broker**: `clientid`, `username` (el autenticado en la conexión del publisher), `qos`, `topic`, `retain`, `publish_received_at` y `payload_b64` (los bytes exactos en base64).
3. Nadie puede publicar en `agro/lab/verified` (ACL: `135 Not authorized`); solo el consumer puede suscribirse a él.
4. El adapter parsea ese envelope con un esquema **cerrado** y deriva `authenticatedPrincipalReference = 'emqx-user:' + username`.

| Dato | Fuente |
|---|---|
| principal autenticado | `username` del envelope: autenticado por EMQX (observado) |
| `mqttClientId` | `clientid` del envelope: observado, **nunca** identidad |
| topic / QoS / retain | observados por el broker |
| bytes | `payload_b64` canónico: exactos |
| `receivedAt` | reloj del adapter (N1 abierto) |
| `connectionReference` | nonce por arranque del adapter |
| `packetId` | `messageId` de la entrega al consumer (solo QoS > 0) |
| realm | **bootstrap**, jamás EMQX, topic ni username |
| `sourceId` y clave técnica | mapping explícito de laboratorio (principal → sourceId + clave) |

## Trusted Computing Base

La regla de EMQX, la ACL y el autenticador forman parte del TCB: quien pueda editarlas puede falsificar identidad. Hay que revisarlas y protegerlas como código.

## Hallazgos de configuración que cambiaron el diseño

- Sin autenticador, EMQX 5 **permite conexiones anónimas**: el laboratorio configura el autenticador antes de cualquier conexión.
- La fuente de ACL por defecto (`file`) permite todo a `127.0.0.1`: se elimina.
- `no_match = deny` obligatorio.

## Pendiente para Producción

Mecanismo real (mTLS/JWT/usuario-contraseña/plugin), PKI, rotación de credenciales, ACL por tenant, gestión de secretos y revisión de reglas (decisiones 18–26, 45–52).
