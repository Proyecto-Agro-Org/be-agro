# INFORME BE13-11I — Aislamiento de stale replay, checkpoint de sesión y eventual delivery (D13 → D13b)

Estado: `LOCAL_LAB_EVIDENCE`. `productionReady=false`. Alcance: sólo la secuencia `D13 → D13b` del grupo durable-tuned. No se tocó Mongo, autenticación, mTLS, versión de EMQX, configuración del broker ni el adapter productivo. Evidencia no versionada: `.local-evidence/be13-11i-R1.json`, `.local-evidence/be13-11i-R2.json`.

## Pregunta y respuesta
Tras reentregar y ACKear los 60 eventos stale de D13, ¿EMQX entrega eventualmente los 59 eventos nuevos de D13b?

**No, dentro de lo observado.** Después de drenar los 60 stale (todos con ACK liberado) no llegó ningún evento propio durante **80,5 s (R1)** y **234 s (R2)**, con 4 reconexiones adicionales de la misma sesión (`sessionPresent=true`) que no entregaron ningún paquete. Clasificación: **`SESSION_STATE_LOSS_LOCAL`** (con `NOT_OBSERVED_IN_RECOVERED_SESSION`: no se afirma borrado físico).

Se corrige la lectura previa solo en un punto: la causa **no** es que los stale ocupen la ventana del arnés (H1 refutada como explicación de la no-entrega permanente): el único evento propio entregado llegó **antes** que cualquier stale, y después del drenaje no llegó nada.

## Corridas (máx. 3; usadas 2)
| Corrida | Config | D13b: publicados / PUBACK | propios entregados | neverDelivered | stale entregados / ACKeados | recibos / ACK propios | Resultado |
|---|---|---|---|---|---|---|---|
| R1 | ventana original de 11H | 60 / 60 | 1 | 59 | 60 / 60 | 0 / 0 | patrón reconfirmado |
| R2 | misma config + 150 s de observación tras la ventana (timeout `BE13_11I_EXTEND_MS=150000`, ~2× la ventana original de ~100 s) | 60 / 60 | 1 | 59 | 60 / 60 | 0 / 0 | `NOT_EVENTUALLY_DELIVERED` tras drenar (`PARTIAL` por el 1 previo); timeout agotado |
| R3 | no ejecutada | | | | | | R1 y R2 no se contradicen |

D13 (idéntico en R1 y R2): publicados 60, PUBACK 60, entregados 60, recibos 60, ACK de consumer 60, mediciones 60, 0 reinicios del supervisor.

## Línea de tiempo (ms desde el inicio del proceso)
| | R1 | R2 |
|---|---|---|
| único propio entregado (`e11f-d13b-0`, `DUP=0`, pid 61) | 56 380 | 50 930 |
| primer stale | 65 904 | 60 459 |
| último stale | 77 092 | 71 567 |
| último ACK de stale | 77 154 | 71 615 |
| stale antes del primer propio | 0 | 0 |
| propios entregados antes / después del drenaje | 1 / 0 | 1 / 0 |
| tiempo último stale ACK → primer propio posterior | no ocurrió | no ocurrió |
| fin de observación (S5) | 157 674 | 305 565 |
| observación post-drenaje | 80,5 s | 234 s |
| reconexiones post-drenaje (todas `sessionPresent=true`, 0 paquetes) | 4 | 4 |

Los 60 stale llegan en ~11 s, con packet ids 61–120 y orden monotónico `d13-0…d13-59` (`d13-32` llega dos veces). El propio llegó con el pid 61 que luego reutiliza `d13-0`.

## MQTT DUP (observado con `packetreceive` de MQTT.js)
- D13b (62 paquetes publish): 59 eventos stale llegan una sola vez con `DUP=1`; `d13-32` llega dos veces (`DUP=0` y luego `DUP=1`); el evento propio llega con `DUP=0`. Es decir, 60 paquetes con `DUP=1`, 2 con `DUP=0`. Idéntico en R1 y R2.
- D13 (primera vez): 33 paquetes `DUP=0`, 28 `DUP=1` (reentregas dentro de D13 tras el restart del broker y la pausa de Mongo).

## Snapshots de sesión (S0–S5) y campos internos
Fuente: `GET /clients/lab-consumer-durable` y `GET /subscriptions?clientid=…`. `GET …/inflight_messages` y `…/mqueue_messages` devuelven **501 `API not implemented for persistent sessions`** (404 con el cliente desconectado) → `NOT_EXPOSED` (no existe forma de listar mensajes/ids en vuelo ni en cola de una sesión durable en esta versión).

**Limitación del arnés descubierta en 11I (importante):** el `api()` del laboratorio (`emqx-lab.ts`) cortaba **todas** las respuestas a 600 caracteres. El "arreglo" de 11H (parsear la respuesta completa) no alcanzaba, porque el corte ocurría aguas arriba. En R1/R2 el JSON de `/clients/{id}` llegó truncado: el parseo estructurado falló y los campos aparecían vacíos. Se corrigió después de R1/R2 (`api(..., { full: true })` para los snapshots + `salvagePrefixFields`, que reporta los campos completos del prefijo como `OBSERVED_PARTIAL_BODY` y el resto como `NOT_OBSERVED_TRUNCATED`, nunca como `NOT_EXPOSED`). **No se repitieron R1/R2** (presupuesto, y no hay contradicción que justifique R3); los valores de abajo salen de los primeros 600 caracteres guardados, el orden de campos varía entre respuestas, por lo que la cobertura por snapshot es parcial. `connected`, `clean_start` y `expiry_interval` no aparecen completos en ningún prefijo (`NOT_OBSERVED_TRUNCATED`).

| Campo (nombre exacto) | S0 | S1 | S2 | S3 | S4 | S5 |
|---|---|---|---|---|---|---|
| `seqno_q1_comm` R1 | n/o | 60 | 60 | 60 | **92** | **120** |
| `seqno_q1_comm` R2 | 0 | 60 | 60 | 60 | **92** | **120** |
| `seqno_q1_dup` R1 | 0 | 60 | n/o | n/o | n/o | n/o |
| `inflight_cnt` R1 | 0 | 0 | 0 | 0 | **28** | 0 |
| `mqueue_len` | 0/n/o | 0 | 0 | 0 | 0 | 0 |
| `mailbox_len` R1 | n/o | n/o | 1 | 0 | 1 | 0 |
| `send_msg.qos1` R1 | 0 | n/o | 0 | 0 | 28 | 0 |
| `inflight_max` | — | 32 | 32 | 32 | 32 | 32 |
| suscripción (`/subscriptions`) | qos 1, `durable=true` | igual | igual | **qos 2** | qos 2 | qos 2 |
| `sessionPresent` (CONNACK) | false | true | (offline) | true | — | — |
| HTTP `/clients/{id}` | 200 | 200 | 200 | 200 | 200 | 200 |

`n/o` = `NOT_OBSERVED_TRUNCATED`. S2 se toma con el consumer desconectado: la API sigue devolviendo la sesión (`disconnected_at`, `is_expired=false`, `is_persistent=true`).

Interpretación segura / no demostrada, por campo relevante:
- `seqno_q1_comm`: valor observado 0 → 60 → 60 → 60 → 92 → 120. **Segura:** crece con los QoS 1 enviados a la sesión; vale 60 tras D13 y 120 al final, igual a las 60 + 60 publicaciones PUBACKed de D13 + D13b. **No demostrada:** que sea un checkpoint/commit del consumer ni que "120" signifique que los 59 propios fueron saltados; no se afirma. El valor 92 = 60 + `inflight_max` (32) coincide con una ventana de 32 mensajes enviados sin ACK en S4 (`inflight_cnt=28`).
- `inflight_cnt` / `mqueue_len`: tras el drenaje (S5) 0 y 0: no hay nada pendiente observable para el cliente. La lista de mensajes `NOT_EXPOSED`, por lo que no se puede verificar si "los 59" siguen en el almacenamiento durable.
- `qos` de la suscripción 1 → 2 a partir de S3: el adapter productivo (`customHandleAcks`/subscribe del arnés) cambia el QoS pedido; observado, no investigado.

## Stale processing (60 de D13)
Confirmado en R1 y R2: los 60 stale pertenecen a D13 (`staleByScenario: {d13: 60}`), ya habían sido procesados (60 mediciones en D13), llegan (59 con `DUP=1` único, `d13-32` con `DUP=0` y `DUP=1`), se persisten con recibo durable, el consumer libera el ACK (60/60) y downstream los resuelve como `completed:admission-processed` (duplicado). No quedan inflight indefinidamente: `inflight_cnt=0` en S5.

## Hipótesis (sólo H1–H5)
| H | Hipótesis | Evidencia | Estado |
|---|---|---|---|
| H1 | stale ocupan la ventana y los nuevos quedan detrás | el propio llegó antes que los stale; tras el drenaje, 80–234 s sin entrega | **refutada** como causa de la no-entrega permanente |
| H2 | los nuevos están en una cola durable y llegan luego | 234 s y 4 reconexiones sin entrega; `mqueue_len=0`, `inflight_cnt=0`; lista de mensajes `NOT_EXPOSED` | **sin apoyo** (no descartable de forma física) |
| H3 | los nuevos no están en el estado restaurado | `NOT_OBSERVED_IN_RECOVERED_SESSION`: 0 paquetes tras el drenaje | **apoyada** |
| H4 | el estado ACK/inflight de D13 se restaura mal y provoca stale replay | D13 ACKeó 60/60, `seqno_q1_comm=60` antes del restart, y aun así los 60 vuelven con `DUP=1` | **apoyada** (observación, sin causa interna demostrada) |
| H5 | mixto | stale replay (H4) + no-entrega de 59 (H3) en la misma sesión | **observada** |

## Clasificación final
**`SESSION_STATE_LOSS_LOCAL`**, con stale replay concurrente (H4/H5). Matiz: 1 de 60 propios se entregó (antes del drenaje), por lo que también podría leerse como `MIXED_SESSION_FAILURE_LOCAL`; se eligió `SESSION_STATE_LOSS_LOCAL` porque, según la regla preestablecida, nada llegó después del drenaje y el timeout. No se activó `QUEUED_BUT_NOT_DELIVERED_LOCAL` (la cola no se pudo listar).

## Impacto sobre F-E2 y fila 72
La descripción de 11H ("no se sabe si se habrían entregado más tarde") queda respondida: **no llegan**, ni tras drenar los stale ni en una ventana 2,3× mayor. El caso D13b **no** es sólo demora/starvation: sigue siendo una no-entrega tras PUBACK dependiente del historial de sesión. F-E2 sigue `BLOCKED_BY_BROKER_CAPABILITY`. No existe recibo+ACK+inbox ausente (0): sin pérdida Mongo. La fila 72 se actualizó con esta evidencia sin elegir opción productiva.

## Limitaciones
- Dos corridas locales, un solo broker/versión (5.8.6 CE), una sola secuencia.
- Snapshots con campos parciales (límite 600 caracteres del laboratorio, corregido tras R1/R2 y cubierto por test).
- No se pudo listar inflight ni cola por mensaje (`501`); no se puede afirmar presencia/ausencia física de los 59 en el almacenamiento durable.
- No se probó otra versión/modo del broker (fuera de alcance).
- El `connack` de S3 se pidió inmediatamente tras el CONNACK; el primer paquete ya podía estar en vuelo.
- Evento propio entregado (`d13b-0`) quedó sin ACK (Mongo sin mayoría) y se resolvió por reconciliación `recovered-and-processed`; eso explica 1 medición propia con 0 recibos propios.

## Tests nuevos
`test/be13-11i-delivery-order.test.js` (10 tests offline): decodificación del envelope y escenario, snapshot completo vs. truncado, separación stale/propio, orden y gap del drenaje, clasificación eventual, clasificación del resultado, configuración histórica intacta, `api full`. Se ajustó la regex del test H1 de 11H para admitir el snapshot adicional.

## Presupuesto usado
2 corridas (R1, R2), 0 R3, 1 suite final.
