# BE13-11B — Contrato del Durable Broker Inbox

Fuentes: `src/iot/mqtt-ingestion-boundary.contracts.ts`, `src/repositories/mongo-broker-inbox.store.ts`, `src/models/broker-inbox.models.ts`.

## Puerto

```ts
interface DurableBrokerInbox {
  persistVerifiedDelivery(request: InboxPersistRequest): Promise<PersistedBrokerDeliveryReceipt>;
  getById({ realm, inboxId }): Promise<InboxRecord | null>;
  ping(): Promise<boolean>;
}
```

No hay update, delete ni TTL. El placeholder (`createBlockingMqttBoundaryPlaceholders().durableInbox`) nunca confirma una escritura.

## Entrada

Solo la construye el boundary, después de VERIFIED y del identity mapping. Contiene `realm`, `sourceId` (del mapping), `principalReference`, `technicalDeviceKey`, `connectionReference`, `mqttClientId`, `topic`, `qos`, `retain`, `packetId`, `receivedAt`, `verifiedAt`, las revisiones del verifier y del mapping, `contextFingerprint`, `rawPayloadSha256` y `rawPayload` (bytes).

El store además:

- copia los bytes;
- recomputa el sha y el `contextFingerprint`, y se niega a escribir si no coinciden (`INBOX_PAYLOAD_HASH_MISMATCH` / `INBOX_CONTEXT_MISMATCH`);
- rechaza un realm distinto del suyo.

## Documento (`<prefix>_broker_inbox`, `$jsonSchema` cerrado)

| Campo | Tipo / regla | Origen |
| --- | --- | --- |
| `_id` | `^ib_[0-9a-f]{32}$` | `inboxId` aleatorio del store |
| `realm` | enum de realms | bootstrap |
| `sourceId`, `technicalDeviceKey` | id técnico | identity mapping |
| `principalReference`, `connectionReference` | referencia segura | lo observado, confirmado por el verifier |
| `mqttClientId`, `topic`, `qos` (int 0–2), `retain` (bool), `packetId` (int 1–65535 o null), `receivedAt` (date) | — | lo observado |
| `verifiedAt` (date), `verifierRevision`, `mappingRevision` | — | verifier y mapping |
| `contextFingerprint`, `rawPayloadSha256`, `provenanceFingerprint` | hex64 | recomputados por el store |
| `rawPayload` | binData (bytes exactos) | entrega |
| `rawPayloadBytes` | int 0–16 MiB | store |
| `rawPersistedAt` | date | **servidor Mongo `$$NOW`** |

`additionalProperties: false` rechaza `password`, `token`, `x-emqx-key` y cualquier otro campo (I17).

## Durabilidad

- Escritura: `updateOne` con upsert sobre un `_id` nuevo, `w: 'majority'`, `j: true`, `wtimeoutMS: 5000`. Si no inserta, falla (`INBOX_NOT_PERSISTED`).
- Receipt: solo después de releer `{ _id, realm }` con `readConcern: majority` y comparar el sha y la procedencia.
- Lecturas de recuperación: siempre `readConcern: majority`, filtrando por realm.

## `rawPersistedAt`

Es la hora del servidor MongoDB en la operación que crea el registro (`$$NOW`). **No** es el instante del commit majority ni de la confirmación del journal. No viene del dispositivo, del caller, del payload ni del adapter. Tampoco es `receivedAt` (hora del adapter), `deviceTimestamp` ni `declaredAt`. En Mongo real quedó dentro de ±1 s de `hello.localTime` del servidor medido antes y después de la escritura (I06).

## Índices

| Índice | Uso |
| --- | --- |
| `_id` | recuperación por `{ _id, realm }` (plan ganador `EXPRESS`/`IDHACK`, I25) |
| `inbox_realm_persisted` `{ realm, rawPersistedAt }` | inspección o backlog por realm y tiempo (I25). No hay índices de worker |

## Retención y privacidad

Se retiene por defecto. **No hay TTL** y la retención es una decisión humana pendiente. El payload crudo podría contener información sensible según el dispositivo futuro: su clasificación de privacidad está pendiente y debe resolverse antes de Production. Nunca se guardan credenciales del broker: el payload crudo no es un secreto del broker, y la forma cerrada de la entrega impide meterlas.
