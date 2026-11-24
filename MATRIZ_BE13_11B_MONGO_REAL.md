# BE13-11B — Campaña Mongo real

Entorno:

- Replica set local de 3 nodos, MongoDB **8.0.38**, Docker, `127.0.0.1:27071-27073`.
- 10 conexiones independientes.
- Lanzador: `-Suite be13-11b` (árbol limpio y `npm run build` previo).
- Entregas, principal, verifier y mapping sintéticos. Sin broker, Atlas ni credenciales.

## Corridas

| Corrida | SHA | Resultado | Limpieza |
| --- | --- | --- | --- |
| 1 | `7b11a90` | **27/27** | `cleanupConfirmed: true` |
| 2 | `7b11a90` | **27/27** | `cleanupConfirmed: true` |
| Regresión `be13-11a` | `7b11a90` | 13/13 | sí |
| Regresión `be13-10b` | `7b11a90` | 28/28 | sí |

**Por qué 27 y no 26:** son I01–I26 pedidos más I27 (failover real del primario).

## Escenarios

| ID | Escenario | Resultado |
| --- | --- | --- |
| I01 | Entrega verificada | registro BinData con realm y sha; receipt; 0 mediciones todavía |
| I02 / I03 / I04 | Procedencia REJECTED, UNVERIFIED o verifier caído | sin inbox, cuarentena ni medición |
| I05 | Bytes exactos | `Buffer.compare == 0` |
| I06 | `rawPersistedAt` del servidor | entre `hello.localTime` antes y después (±1 s) |
| I07 | `rawPersistedAt` forjado | `broker-context-malformed`; el camino directo queda `quarantined` |
| I08 | Aislamiento por realm del store | `null` |
| I09 | `sourceId` del mapping | `synthetic-ingest` |
| I10 | Entregas idénticas | 2 registros, 1 medición |
| I11 | Persist-only y recuperación con conexión y servicio nuevos | `accepted` |
| I12 | Segunda recuperación | `duplicate` |
| I13 / I14 / I15 | Manipulación directa de bytes, hash, `sourceId`, `verifierRevision` o topic | `broker-inbox-integrity-failed`, sin medición |
| I16 | Recuperación desde otro realm | `broker-inbox-not-found`; store de otro realm → `null` |
| I17 | `$jsonSchema`: sin realm, QoS 3, `sourceId` vacío, sin `rawPersistedAt`, hash inválido, `password`, `x-emqx-key`, `_id` de packet id, payload no binario | 121 |
| I18 | **Majority caída** (secundarios pausados) | `broker-inbox-unavailable` (reintentable); 0 mediciones. Tras recuperarse: 1 registro huérfano sin receipt (N4) |
| I19 | Escritura confirmada y pipeline caído | `quarantined`; registro intacto; recuperación posterior `accepted` |
| I20 / I21 | 2 y 10 recuperaciones concurrentes en conexiones separadas | 1 medición (corrida 2: 1 `accepted` y el resto `duplicate`) |
| I22 | Mediciones duplicadas en toda la campaña | ninguna |
| I23 | Audit | ≥ 10 eventos del inbox, sin payload |
| I24 | Métricas | sin `inboxId`, `eventId`, client id, topic ni `sourceId` |
| I25 | Planes de consulta | `{ _id, realm }` → `_id`; `{ realm, rawPersistedAt }` → `inbox_realm_persisted` |
| I27 | **Failover**: persistir, detener el primario y recuperar desde el nuevo primario | `accepted` (corrida 2: nodo 0 detenido, nuevo primario nodo 1) |
| I26 | Limpieza | confirmada por el lanzador |

## Mutante sobre la campaña real

M3 (realm fuera de la query de recuperación del store): la campaña falla en **I08**.
