# BE13-01 — Matriz de fixtures

Directorio: `docs/be13-01/fixtures/`. La metadata completa está en `manifest.json`.

| ID | Evento | Evidencia | Resultado ingesta | Resultado BE-12 | Propósito |
|---|---|---|---|---|---|
| F01 | telemetry simulated | SINTÉTICO | accepted | blocked | envelope positivo sin autoridad física/comercial |
| F02 | device-status | SINTÉTICO | accepted | not-a-measurement | estado técnico separado de telemetría |
| F03 | connected | SINTÉTICO | accepted | not-a-measurement | evento de conexión solo respaldado por factory/prueba |
| F04 | disconnected | SINTÉTICO | accepted | not-a-measurement | evento de desconexión solo respaldado por factory/prueba |
| F05 | retry original | SINTÉTICO | accepted, luego duplicate ACK | single-candidate | estabilidad de eventId y bytes |
| F06 | replay alterado | SINTÉTICO | 409 conflict | not-delivered | mismo eventId con payload diferente |
| F07 | parcial null/cero | SINTÉTICO | accepted | blocked | preservar ausencia y cero, sin normalizar |
| F08 | eventId ausente | SINTÉTICO | rejected | not-delivered | campo obligatorio |
| F09 | identidad contradictoria | SINTÉTICO | rejected | not-delivered | payload no puede sustituir clientid |
| F10 | sentAt inválido | SINTÉTICO | rejected | not-delivered | epoch obligatorio |
| F11 | deep sleep | SINTÉTICO | conditional accepted | blocked | deviceTimestamp antiguo no autoriza atribución |
| F12 | magnitud desconocida | SINTÉTICO | accepted | blocked-invalid-catalogue | ingesta no aprueba catálogo |
| F13 | medición legacy | OBSERVADO EN CÓDIGO | accepted por legacy actual | blocked | caracteriza cuerpo flexible inseguro |
| F14 | status legacy | OBSERVADO EN CÓDIGO | accepted por legacy actual | not-a-measurement | caracteriza aliases y upsert declarado |

## Cobertura negativa pendiente de evidencia externa

- Duplicado real emitido por EMQX con headers/body exactos.
- Reentrega después de pérdida de ACK del bridge real.
- Eventos de conexión/desconexión de la versión/edición EMQX utilizada.
- Topic, QoS, retain, DUP, packet ID y campos de rule engine reales.
- Reloj del broker y reloj de hardware desincronizados.
- Reinicio, deep sleep y backlog reales.
- Dos dispositivos con clientid colisionante o rotado.

Estos casos no tienen fixture positivo aprobado hasta recibir muestras sanitizadas.
