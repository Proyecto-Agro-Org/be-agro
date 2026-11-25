# INFORME BE13-11D — Auditoría de seguridad

Alcance: adapter MQTT/EMQX de laboratorio, persist-before-ack y recuperación de `receipted`. Solo loopback; credenciales TEST_ONLY generadas por corrida.

## Hallazgos

| ID | Severidad | Hallazgo | Estado |
|---|---|---|---|
| F-D1 | Alto (mitigado) | `customHandleAcks` de MQTT.js **solo se respeta con MQTT 5**; con 3.1.1 la librería ACKea automáticamente y en silencio. Una configuración incorrecta rompería persist-before-ack sin ningún error. | Mitigado: el adapter fuerza `protocolVersion: 5`; D05 falla si cambia. |
| F-D2 | Alto (de diseño) | Un suscriptor MQTT **no ve** quién publicó. Tomar la identidad del topic/payload/sesión sería spoofeable. | Resuelto con regla de EMQX que genera un envelope con `clientid` y `username` autenticados; ACL impide forjarlo (E06). La regla y la ACL son TCB. |
| F-D3 | Medio | EMQX 5 permite conexiones **anónimas** si no hay autenticador. | El laboratorio configura el autenticador antes de conectar. |
| F-D4 | Medio | La fuente de ACL por defecto (`file`) permite todo a `127.0.0.1`. | Eliminada; `no_match = deny`. |
| F-D5 | Medio | Un PUBACK con reason code de error no pide reentrega en MQTT 5. | Los fallos se manejan **sin ACK y cortando la conexión**. |
| F-D6 | Medio (residual) | `customHandleAcks` pendiente serializa las entregas de la conexión: un inbox lento frena al consumer. | Residual; sin evaluación de rendimiento. |
| F-D7 | Bajo | Cada sesión suscrita recibe cada mensaje: más de un `clientId` de consumer duplica entregas. | Laboratorio: un solo `clientId`; decisión de topología pendiente. |
| F-D8 | Bajo | Los tipos de `mqtt` arrastran tipos DOM que `lib: ["ES2022"]` no tiene. `skipLibCheck` rompió tipos de mongoose existentes. | Resuelto con carga dinámica y tipado local; `skipLibCheck` rechazado. |
| F-D9 | Bajo (arnés) | En Windows `SIGKILL` no informa señal; `end(true)` descartaba un PUBLISH QoS 0. | Arnés corregido; sin cambios de producto. |
| R1 | Medio | Registro `receipted` sin dueño tras la muerte del consumer. | **CLOSED_LOCAL** (E20/E21/E22, R-A…R-F). |

## Superficie nueva

- Dependencia: `mqtt@5.16.1` (MIT, 37 paquetes añadidos con la librería, `npm audit`: 0 vulnerabilidades al momento de instalar). Cadena de suministro a revisar antes de cualquier uso no local (decisión 52).
- Contenedor `emqx/emqx:5.8.6` solo en `127.0.0.1`.

## Controles verificados

Guard loopback (D01), credenciales TEST_ONLY (D02, E36), envelope cerrado (D04, A17/A18), spoofs (E05–E09, E37), no persistencia de rechazos de seguridad (E03, E26b/E27b), persist-before-ack con procesos reales matados (E18–E20), aislamiento por realm (E21c), sin secretos en logs/registros (E35, E36), `productionReady: false`.

## Riesgos residuales

El adapter, la regla y la ACL son TCB. El reloj del adapter sigue siendo la fuente de `receivedAt` (N1 abierto). Sin pruebas de carga. Los fingerprints no son MAC. Falta una política productiva de mensajes veneno, de sesiones y de reconexión. La topología de un solo broker no valida clustering de EMQX.

## N1 y N4

N1: **OPEN / BLOCKED_BY_POLICY** (evidencia E32 sin cambiar la regla). N4: sigue **CLOSED_LOCAL**; E33 reprodujo un registro huérfano real y E34 lo resolvió.

## Secret scan

0 hallazgos en lo versionado; las credenciales generadas no aparecen en logs de EMQX, registros del inbox, audit, métricas ni evidencia.
