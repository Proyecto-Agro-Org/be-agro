# INFORME BE13-11D — Primera integración real con EMQX local desechable

Fecha: 2026-11-25. Base: `dev` `41590a7a72993f9c57b378e8f42f4ccb52a475e5`; `main` `1bb20f76b7a739f42c75b37b9a64315276560ec1` (intacto). Todo `LOCAL_TEST_ONLY`: loopback, credenciales generadas por corrida, sin Atlas, sin hardware, sin Production. `productionReady` = `false`.

## Cadena probada con un broker real

```
publisher MQTT (usuario/contraseña TEST_ONLY) → EMQX 5.8.6 (auth + ACL + regla del broker)
 → adapter (MQTT.js 5.16.1, MQTT 5, ACK diferido) → provenance + identity mapping
 → Durable Inbox (Mongo, majority + j) → receipt → PUBACK → pipeline BE13 → Mongo local
```

## Conclusión sobre el ACK

`ACK_CONTROL = AVAILABLE`. MQTT.js 5.16.1 retiene PUBACK/PUBREC hasta que `customHandleAcks` llama a su callback, **solo con MQTT 5**. Persist-before-ack quedó demostrado con procesos consumer reales matados en tres puntos (E18, E19, E20) y con orden `persist → acked → processed` (E04). Limitaciones: QoS 0 no tiene ACK ni redelivery (pérdida demostrada, E13); los duplicados siguen siendo posibles (E11, E19); un PUBACK de error no sirve para pedir reentrega, así que ante un fallo se corta la conexión; las entregas de una conexión se serializan.

## Cómo llega la identidad del publisher

Un suscriptor MQTT no ve al publisher. Una **regla del motor de reglas de EMQX** reenvía cada publicación a un topic que nadie puede publicar (ACL) con `clientid`, `username` y los bytes en base64; el adapter lo parsea con un esquema cerrado. Detalle y TCB en `ADR_BE13_11D_LOCAL_BROKER_AUTH.md`.

## Resultados

| Verificación | Resultado |
|---|---|
| Campaña EMQX real (2 corridas finales) | 34/34 y 34/34, 0 FAIL, 0 NO_VERIFICABLE, 0 contenedores residuales |
| Pruebas funcionales nuevas | 22 (`D01–D16`, `R-A…R-F`) |
| Pruebas adversariales offline nuevas | 9 (+ vectores mapeados a la campaña real) |
| Mutantes | 7/7 (5 offline, 2 contra EMQX/Mongo reales) |
| Suite completa | **1014/1014** (983 previas + 31) |
| HTTP | 13/13 |
| Regresión BE13-11C (Mongo) | 23/23 ×2 (tras ajustar C18 al único índice nuevo) |
| Regresión BE13-11B | 27/27 |
| Regresión BE13-11A | 13/13 |
| Regresión BE13-10B | 28/28 |
| Secret scan | 0 credenciales/URLs reales (solo literales de pruebas negativas) |

Las regresiones Mongo se ejecutaron completas porque cambió código común (store/servicio de reconciliación, estado del inbox con un índice nuevo, vocabularios de métricas, launcher).

## Hallazgos

Ver `INFORME_BE13_11D_AUDITORIA_SEGURIDAD.md`: F-D1…F-D9 y R1. Estados de arrastre:

| Hallazgo | Estado |
|---|---|
| N1 reloj | **OPEN / BLOCKED_BY_POLICY**. Evidencia real: `publish_received_at` del broker y `receivedAt` del adapter coinciden (mismo host) y Mongo persiste ~7 ms después. Una posible fuente alternativa (B: metadata del broker) ya existe en el envelope, **sin cambiar el contrato ni elegir tolerancia**. |
| N4 | Sigue **CLOSED_LOCAL**; E33 reprodujo un huérfano real y E34 lo resolvió. |
| R1 `receipted` sin dueño | **CLOSED_LOCAL** (E20/E21/E22). |

## Cambios de código

`src/adapters/emqx-mqtt-broker.adapter.ts` y `emqx-mqtt-connect.ts` (laboratorio), política `ReceiptedDeliveryRecoveryPolicy` (BLOCKED por defecto) en contratos/servicio/store, `receiptedAt` y un índice en el estado del inbox, métricas `broker_adapter_*`, `mqtt@5.16.1` en `package.json`/`package-lock.json`, suite `be13-11d` del launcher y `scripts/be13-11d/*`. **No** se tocó `app.ts`; no hay worker productivo.

## Riesgos residuales

Adapter, regla y ACL son TCB; sin pruebas de carga; un solo broker (sin clustering); N1 abierto; sin política productiva de sesiones, reconexión, mensajes veneno ni edad de recuperación; nueva dependencia a revisar.

## Decisiones humanas

Nuevas 45–52 en `MATRIZ_DECISIONES_HUMANAS_BE13.md`; ninguna elegida. La autenticación productiva sigue `PENDING`.
