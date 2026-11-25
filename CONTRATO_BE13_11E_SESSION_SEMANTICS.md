# CONTRATO BE13-11E — Semántica de sesiones y reconexión (laboratorio)

Todo lo siguiente se **observó** contra EMQX 5.8.6 + MQTT.js 5.16.1 en loopback (`LOCAL_LAB_EVIDENCE`). No es una política productiva.

## Perfiles probados

| Perfil | Configuración | Resultado observado |
|---|---|---|
| S1 clean start | `clean: true` | Lo publicado mientras el consumer está offline **se pierde** (0 de 20 entregados al volver). |
| S2 sesión persistente | `clean: false`, `sessionExpiryInterval` TEST_ONLY | Lo publicado offline se entrega al reconectar (20 de 20). |
| S3 reinicio del consumer con sesión | mismo `clientId`, `clean: false` | Cero pérdida bajo carga (T11), reentrega de lo no ACKeado. |
| S4 reinicio del broker | EMQX reiniciado bajo carga | **Pérdida**: los mensajes ya aceptados por el broker pero todavía en cola de la sesión (en memoria) no sobreviven (T10, ver `MATRIZ_BE13_11E_FAILURES.md`). |

## Reglas verificadas

1. **Un `clientId` = una sesión.** Reiniciar un consumer con el mismo `clientId` puede chocar con el takeover de EMQX durante unos instantes: el arranque debe reintentarse.
2. **Cada sesión suscrita recibe cada mensaje.** Dos `clientId` distintos en el mismo topic duplican **todas** las entregas (T14: 60 eventos ⇒ 120 entregas, 120 registros de inbox, 60 mediciones). No es una estrategia de escalado.
3. **Suscripción compartida** (`$share/<grupo>/…`): cada mensaje va a **un** miembro (T15: sin duplicación de entregas). Con miembros de sesión limpia, la caída de un miembro **pierde** lo que tenía en vuelo o en cola.
4. **Reentrega:** un mensaje no ACKeado se reentrega con `dup: true` al reanudar la sesión. Si el consumer lo rechaza de forma permanente y no lo ACKea, se reentrega **sin fin** (T16).
5. **Cada arranque del adapter genera una `connectionReference` nueva.** Ninguna identidad ni estado de confianza sobrevive a una reconexión; el principal se toma del envelope de cada entrega (T13: 0 eventos atribuidos a otro principal).
6. **`start()` nunca queda colgado:** si la conexión se cierra antes de estar lista (por ejemplo, porque la sesión reanudada reentregó un mensaje que se retiene), rechaza (hallazgo F-E3, corregido).
7. **`receiveMaximum`** (propiedad MQTT 5) no cambia la serialización de entregas dentro del consumer (T06).

## Reconexión

El adapter no reconecta por sí solo (`reconnectPeriod: 0`). En el laboratorio un supervisor mínimo (arnés, no un worker productivo) arranca un adapter **nuevo** cuando `closed()` es `true`. Tiempos observados (T08–T13): `LOCAL_LAB_EVIDENCE`; no se eligió ningún backoff productivo.

## Pendiente (decisiones humanas)

Política de sesión productiva (clean start, expiración), durabilidad de sesiones de EMQX ante reinicio, reconexión y backoff, modelo de consumers (decisiones 48, 49, 51 y nuevas 53–60).
