# MATRIZ BE13-11E — Modos de fallo observados

Todo es `LOCAL_LAB_EVIDENCE` (ver `MATRIZ_BE13_11E_BENCHMARK.md`). "Pérdida" significa: el evento no llegó a tener ni medición ni registro de cuarentena ni registro durable en el inbox.

| Fallo inyectado | Qué se observó | ¿Pérdida? | ¿Medición duplicada? | Cómo se resuelve |
|---|---|---|---|---|
| Mongo pierde la majority (~8 s) con carga (T08) | Sin receipt no hay ACK; el consumer retiene y corta la conexión; reentrega al sanar | **0** | 0 | Reentrega del broker; registros huérfanos ambiguos (N4) por reconciliación |
| Failover del primary de Mongo con carga (T09) | Entregas esperan la elección; un evento ACKeado cuyo procesamiento cayó en la elección terminó en **cuarentena** (1 de las 2 corridas finales; en la otra todos se materializaron: no determinista) | **0** | 0 | Replay de la cuarentena (operador) o recuperación de `receipted` si el estado quedó `receipted` |
| Reinicio del consumer ×3 con sesión persistente (T11) | 50–61 entregas reentregadas | **0** | 0 | Sesión del broker + idempotencia |
| **Reinicio del broker EMQX con carga (T10)** | Los mensajes aceptados por el broker pero aún en cola de la sesión (memoria) **se pierden**: 145–147 de 200 no llegaron al consumer | **Sí (73 %)** | 0 | **Sin mitigación en el sistema**: los publishers solo reintentan lo que el broker no confirmó (F-E2) |
| Consumer muerto tras el ACK, antes de la medición (T19) | Registro durable `receipted`; el broker no reentrega | 0 | 0 | Recuperación de `receipted` (3 ejecutores: 30 de 30 una vez) |
| Escritura ambigua del inbox (T20) | Registro durable sin receipt | 0 | 0 | Reconciliación (3 ejecutores: 20 de 20 una vez) |
| Sesión limpia (S1) con el consumer offline (T12) | Lo publicado offline se pierde (0 de 20) | **Sí** | 0 | Usar sesión persistente (S2: 20 de 20) |
| Miembro de suscripción compartida muere con sesión limpia (T15) | Mensajes en vuelo/en cola del miembro caído se pierden (48–53 de 160) | **Sí** | 0 | Sesión persistente o no usar suscripciones compartidas con sesión limpia |
| Dos `clientId` distintos en el mismo topic (T14) | Todo se entrega a ambos | 0 | 0 (la idempotencia lo evita) | No usar como escalado: duplica el trabajo |
| Mensaje veneno con política `withhold` (T16) | Reentrega **sin fin** (10 entregas en 9 s) | 0 | 0 | Política de laboratorio `ack-and-drop`; la política productiva sigue pendiente (decisión 42/62) |
| Mensaje veneno con `ack-and-drop` | Una entrega, sin reentrega, sin inbox | el mensaje se descarta | 0 | Contado en métricas |
| Atacante autenticado sin mapping ×200 (T18) | 0 inbox / 0 cuarentena / 0 mediciones | — | — | Rechazado antes de persistir |
| Credenciales inválidas ×40 (T18b) | Rechazadas por el broker | — | — | — |

## Hallazgos de este ciclo

| ID | Severidad | Hallazgo | Estado |
|---|---|---|---|
| **F-E1** | **Alto** | Un resultado `uncertain` (ni medición ni cuarentena pudieron registrarse) marcaba el registro como `completed`: el evento quedaba **irrecuperable**. Reproducido en T09 (1 evento sin medición ni cuarentena) y en una prueba offline (S05). | **Corregido** en `processRecord`; el registro queda `receipted` y la recuperación lo reintenta. |
| **F-E2** | **Alto (residual)** | El broker pierde la cola de sesión al reiniciar (147/200). Persist-before-ack protege **después** de la entrega al consumer; antes, los mensajes ya confirmados al publisher viven en memoria del broker. | **Abierto**: requiere decidir durabilidad de sesiones del broker (decisión 59). |
| **F-E3** | Medio | `start()` del adapter podía colgarse para siempre si una sesión reanudada reentregaba un mensaje retenido antes de completar la suscripción. | **Corregido**: rechaza si la conexión cierra antes de estar lista (S07). |
| F-E4 | Medio | Contención de auditoría: con apéndices concurrentes al mismo stream el throughput total cae ~3.5× (200/s → ~57/s). | Medido; **no rediseñado** (decisión 60). Importa si se escala a varias conexiones. |
| F-E5 | Medio | Un mensaje veneno con política `withhold` se reentrega sin fin. | Demostrado; política productiva pendiente (42/62). |
| F-E6 | Medio | Suscripción compartida con sesión limpia: la caída de un miembro pierde mensajes. | Documentado (decisión 57). |
| F-E7 | Bajo/Medio | `listCandidates` cuesta ~1 s con 30 000 registros del inbox sin estado (usa índice; el costo es el `$lookup`). Crece con el backlog y la retención. | Medido; sin cambios (decisiones 29, 61). |
| F-E8 | Info | En T06 el primer perfil (`receiveMaximum` por defecto) fue ~4× más lento que los siguientes; causa no establecida. | Sin explicar. |
| F-E9 | Bajo | Tras un failover, eventos ACKeados pueden quedar en cuarentena y requieren replay por un operador. | Comportamiento esperado de BE13-09/10B. |
| F-E10 | Info | El consumer serial procesa ~23 eventos/s en esta máquina y está limitado por latencia de E/S (usa ~50–60 % de un núcleo). | Medido; ver `ADR_BE13_11E_CONSUMER_SCALING_OPTIONS.md`. |

## Estado de hallazgos de arrastre

N1 (reloj): sin cambios, **OPEN / BLOCKED_BY_POLICY**. N4: **CLOSED_LOCAL** (T20 lo reconfirma bajo carga con 3 reconciliadores). R1: **CLOSED_LOCAL** (T19 bajo carga). H1–H3 y demás: sin cambios.
