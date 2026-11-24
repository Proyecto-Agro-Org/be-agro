# BE13-11B — Matriz de vectores

## Offline (`test/be13-11b-adversarial.test.js`, 15/15)

| V | Vector | Resultado | Severidad |
| --- | --- | --- | --- |
| A01 | Receipt forjado (id inexistente, forma inválida, campos inventados) | `broker-inbox-not-found`; solo cuenta un registro almacenado | SIN HALLAZGO |
| A02 | `rawPersistedAt` forjado (contexto, sobre, documento armado a mano por replay) | malformado o `denied`; el camino directo queda `BLOCKED` | SIN HALLAZGO |
| A03 | `inboxId` de otro realm (recuperación y replay) | `broker-inbox-not-found` | SIN HALLAZGO |
| A04 | Manipulación de los bytes crudos | integridad | SIN HALLAZGO |
| A05 | Manipulación del contexto (packet id, QoS, `receivedAt`, conexión) | integridad | SIN HALLAZGO |
| A06 | Manipulación de la procedencia (`verifiedAt`, `mappingRevision`) | integridad en recuperación **y** replay | **N2 corregido** |
| A07 | Colisión de packet id | registros distintos; la deduplicación sigue siendo de negocio | SIN HALLAZGO |
| A08 | Colisión de client id MQTT | nunca es identidad del inbox | SIN HALLAZGO |
| A09 | `sourceId` falsificado en el payload | registro y medición con el `sourceId` del mapping | SIN HALLAZGO |
| A10 | Realm falsificado en el topic | se guarda el realm autorizado | SIN HALLAZGO |
| A11 | Campos con forma de credencial | rechazados antes del inbox; el registro no tiene esas claves | SIN HALLAZGO |
| A12 / A13 | Respuesta del store malformada u hostil; store caído | integridad / `broker-inbox-unavailable` con alerta | SIN HALLAZGO |
| A14 | Payload crudo de tamaño excesivo | rechazado antes de verificar y antes del inbox | SIN HALLAZGO |
| A15 | Saltarse el boundary por el camino directo | nunca `accepted`; un verifier inyectado se rechaza | SIN HALLAZGO |
| A16 | Worker, timers, env, borrado, TTL o broker en el código del inbox; `app.ts` | ausentes | SIN HALLAZGO |

## Mongo real

| ID | Vector | Resultado |
| --- | --- | --- |
| I13–I15 | Manipulación directa en Mongo | integridad, sin medición |
| I16 / I08 | Realm cruzado | `null` / `not-found` (mutante M3 detectado en I08) |
| I17 | Documento inválido o con credenciales | 121 |
| I18 | Majority caída | no se procesa; huérfano documentado (N4) |
