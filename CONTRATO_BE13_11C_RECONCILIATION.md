# CONTRATO BE13-11C — Reconciliación del Durable Inbox

Estado: implementado y probado offline y contra MongoDB 8 local (réplica de 3 nodos). Sin worker, sin cron, sin EMQX.

## 1. Qué problema resuelve (N4)

Una escritura al inbox que el llamador no pudo confirmar (por ejemplo `wtimeout` con los secundarios caídos) puede quedar luego en Mongo **sin que ningún receipt haya llegado al proceso**. El registro crudo es válido y durable, pero nadie decidió procesarlo.

## 2. Definición exacta de huérfano

| Término | Definición |
|---|---|
| Registro crudo | Documento del inbox. **Inmutable**: bytes, procedencia, contexto del broker y `rawPersistedAt` nunca se actualizan. |
| Documento de estado | Un documento por `inboxId` en `<prefix>_broker_inbox_state` (`_id = inboxId`). Es la única evidencia operativa. |
| **Candidato a huérfano** (`candidate-orphan`) | Registro crudo del realm **sin documento de estado**: nadie marcó recibo, nadie lo reclamó, nadie lo completó. |
| **Reclamable** | Candidato cuya antigüedad (`rawPersistedAt` frente al reloj de la **base de datos**) supera `minAgeMs` de la política inyectada. |
| Huérfano confirmado | No existe como estado persistido: un reclamo exitoso y su completion son el registro de la decisión. |

No se llama huérfano a "un registro no procesado": un registro con marcador `receipted` pertenece a quien recibió el receipt y **no es reclamable**.

El receipt **no** es la única verdad: el registro crudo confirmado por majority sigue siendo recuperable por `inboxId` aunque el receipt se haya perdido.

## 3. Máquina de estados

```
(sin estado) --admit: receipt validado--> receipted --procesamiento completo--> completed(admission-processed)
(sin estado) --reconciliador: claim-----> claimed   --complete(token,version)--> completed(<outcome>)
claimed      --lease vencido (reloj BD)--> claimed (version+1, token nuevo; el titular anterior queda fuera)
```

Estados: `receipted | claimed | completed`. Outcomes cerrados: `recovered-and-processed`, `already-processed`, `integrity-failed`, `blocked`, `admission-processed`.

Los marcadores `receipted` y `completed(admission-processed)` los escribe la admisión **solo si** se inyecta `reconciliationStore`; son best-effort: si se pierden, el registro simplemente pasa a ser candidato y la reconciliación lo resuelve de forma idempotente (`already-processed`).

## 4. Política (`InboxReconciliationPolicy`)

- Productiva por defecto: **BLOCKED** (`reconciliation-policy-not-decided`). El placeholder del boundary la entrega bloqueada.
- Una política ausente, inválida, con claves extra o con valores negativos se trata como BLOCKED.
- Con política BLOCKED: no se listan candidatos, no se reclama, no se procesa; `inspect-only` solo devuelve conteos.
- `TEST_ONLY` (pruebas) usa valores sintéticos: `minAgeMs=1000`, `claimLeaseMs=5000`. **No son propuestas productivas.** No se eligió ningún tiempo.

## 5. Servicio

`createBrokerInboxReconciler({ realm, admission, reconciliationStore, reconciliationPolicy, audit, metrics, alerts })`

- `reconcileBrokerInbox({ mode, limit })` — `mode`: `inspect-only` | `reconcile`; `limit` entero 1..500 (además acotado por `maxBatch` de la política). Manual, secuencial, sin bucle ni temporizador.
- `reconcileOne(inboxId)` — una unidad de trabajo.
- El `realm` del reconciliador debe coincidir con el de la admisión (bootstrap autorizado); si no, el constructor falla.

### Resultados cerrados

`recovered-and-processed`, `already-processed`, `duplicate`, `integrity-failed`, `blocked`, `stale-reconciliation`, `unavailable`.

| Resultado | Cuándo |
|---|---|
| `recovered-and-processed` | Reclamo ganado, integridad OK, al menos un campo aceptado. |
| `already-processed` | Todas las mediciones ya existían (idempotencia BE13-06). No se inserta otra. |
| `duplicate` | El estado ya estaba `completed`: no se hace nada. |
| `integrity-failed` | Hash/contexto/procedencia no coinciden. **Pegajoso, no reintentable, no se repara.** |
| `blocked` | Política BLOCKED, id inválido o inexistente en el realm, estado `receipted`, o rechazo de configuración/cuarentena. |
| `stale-reconciliation` | Otro reconciliador tiene un claim vigente, o el claim propio fue superado (completion rechazada). |
| `unavailable` | Store o inbox no disponibles; no se registra nada final y el claim vence solo. |

## 6. Claim (CAS) y fencing

- Primer claim: `updateOne({_id, realm, status:{$exists:false}}, pipeline, {upsert:true})`. Si ya existe estado, el upsert choca en `_id` (E11000) y se interpreta como "perdido". **Un único ganador.**
- Takeover: solo si `status='claimed'` y `claimedAt + claimLeaseMs <= $$NOW` (reloj de la **base de datos**, no del proceso). Incrementa `version` y cambia el `token`.
- Completion fenced: `{_id, realm, status:'claimed', token, version}`. Un titular desactualizado no puede completar, ni siquiera mientras el estado sigue `claimed`.
- Antes de reclamar se verifica que el registro crudo exista en el realm.
- Todas las escrituras: `w:majority`, `j:true`, `wtimeoutMS:5000`; lecturas con `readConcern: majority`.
- El claim **no** reemplaza la idempotencia downstream: reduce trabajo duplicado; la medición única la garantiza BE13-06.
- Esta infraestructura **no reutiliza** el lease de cuarentena (BE13-10B): la semántica es distinta (un claim por registro crudo, sin ownership de operador, sin autoridad temporal inyectada). Se reutiliza solo el principio (CAS + fence token + reloj de BD).

## 7. Integridad primero

El procesamiento usa `processPersistedBrokerDelivery`, que recomputa SHA-256 de los bytes, `contextFingerprint` y `provenanceFingerprint` **antes** de cualquier ingesta. Si falla, nada llega al pipeline.

"Evidencia VERIFIED persistida" **no** equivale a verificación consciente de revocaciones (decisión humana 31, pendiente).

## 8. Almacenamiento

Colección `<prefix>_broker_inbox_state`: `$jsonSchema` con `additionalProperties:false`; campos `_id, realm, status, version, token, claimedAt, completedAt, outcome`. Sin payload, sin topic, sin ids de cliente, sin TTL, sin borrado. Único índice: `_id`. El barrido de candidatos recorre el índice existente `inbox_realm_persisted` del inbox crudo y une por `_id`.

## 9. Runner / límites

No hay runner automático. El barrido exige `limit` explícito, modo `inspect-only` disponible, realm fijado por bootstrap, y no lee `rawPayload` (proyección). La campaña local solo corre contra el replica set desechable del launcher (`-AuthorizeDisposable`), nunca contra Atlas.

## 10. Restricciones preservadas

Sin cambios en `app.ts`, sin worker/cron/polling, sin SDK MQTT, sin EMQX, sin credenciales, `productionReady === false`.
