# INFORME BE13-11E — Auditoría de seguridad

Alcance: consumer EMQX local bajo carga, sesiones, concurrencia, reconexión y fallos. Solo loopback; credenciales TEST_ONLY generadas por corrida; sin Atlas, hardware ni Production. La autenticación productiva **no** se eligió.

## TCB (exacto)

| Componente | Rol | Qué falsificaría si se compromete |
|---|---|---|
| Autenticador de EMQX | decide quién se conecta | cualquier identidad de publisher |
| ACL de EMQX | decide dónde publica/suscribe cada principal | publicar en el topic verificado, leer ajeno |
| Regla de EMQX (`lab_verify`) | **autora** `clientid`/`username` del publisher | la identidad de **todos** los publishers |
| Adapter | traduce el envelope a hechos observados | hechos observados |
| Realm de bootstrap | realm del proceso | el realm de todo lo persistido |
| Verifier de procedencia + mapping | autoriza principal → `sourceId` + clave técnica | atribución |

La regla y la ACL son configuración reproducible desde cero (`scripts/be13-11d/emqx-lab.ts`, `startEmqxLab`): la campaña arranca un EMQX nuevo y las crea por la API en cada corrida.

## Verificaciones de seguridad bajo carga

| Control | Evidencia |
|---|---|
| El principal sale de **cada** entrega, nunca de la conexión del consumer ni de la sesión | T13: 200 eventos, 0 atribuidos a otro principal tras 5–6 reinicios del consumer |
| Un principal autenticado sin mapping no genera inbox, cuarentena ni medición | T18 (200 mensajes) |
| Rechazos de seguridad repetidos no persisten | T17 (100) |
| Credenciales inválidas las rechaza el broker | T18b (40/40) |
| Ningún ACK sin receipt durable majority | M1 (mutante ACK temprano) detectado por D06/D07/D08/D12 |
| Idempotencia bajo duplicados | T05, T14, T15 |
| Una sola recuperación por registro bajo concurrencia | T19, T20 (3 ejecutores) |
| Ninguna credencial generada en logs ni registros | E36 de 11D sigue en la campaña de regresión |

## Hallazgos de seguridad y resiliencia

Ver `MATRIZ_BE13_11E_FAILURES.md`: F-E1 (corregido: un resultado `uncertain` hacía irrecuperable un evento), F-E2 (abierto: el reinicio del broker pierde la cola de sesión), F-E3 (corregido: `start()` colgable), F-E4–F-E10.

## Riesgos residuales

- El broker es hoy el único almacén de lo que ya se confirmó al publisher y aún no llegó al consumer: **su cola es memoria**.
- Con varias conexiones el cuello pasaría a la auditoría (contención sobre un contador por stream).
- Mensaje veneno con `withhold` = bucle sin fin; con `ack-and-drop` se descarta con métrica.
- Los números son de una máquina; no hay pruebas de carga multi-nodo ni EMQX en clúster.
- Adapter, regla y ACL siguen siendo TCB; fingerprints no son MAC.

## Dependencia MQTT

`mqtt@5.16.1`, 0 vulnerabilidades, licencias MIT/ISC/BSD-3/0BSD (ver `INFORME_BE13_11E_MQTT_DEPENDENCY_REVIEW.md`). No se actualizó.

## Secret scan

0 credenciales o URLs reales en lo versionado (solo literales de pruebas negativas).
