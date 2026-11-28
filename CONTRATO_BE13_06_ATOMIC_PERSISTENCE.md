# BE13-06 — Contrato de persistencia atómica

## Operación

`createMongoMeasurementPersistence({ connection, prefix, realm }).persistAtomically({ key, fingerprint, event, attribution })`

Requiere MongoDB con replica set (transacciones). Validación previa (antes de abrir sesión): forma estricta, realm de clave y atribución = realm del store, `event.eventId/sourceId` = clave, evento válido según el schema BE-12.

Transacción (`session.withTransaction`, `readConcern: snapshot`, `writeConcern: {w: 'majority', j: true}`, `maxCommitTimeMS: 3000`, `timeoutMS: 15000`):

1. Leer el claim en el snapshot. Existe → `duplicate` (mismo fingerprint) o `conflict`; no se escribe nada.
2. Crear el claim (`updateOne` con `upsert` + `$setOnInsert` + `$currentDate`). Reversible hasta el commit.
3. Insertar la medición con `_id` determinista vinculada al claim.
4. Commit.

Errores transitorios (`TransientTransactionError`, write conflicts por concurrencia) → el driver reintenta la transacción completa; el callback reinicia su resultado en cada intento. Un `E11000` porque otra transacción confirmó la misma clave → se relee el claim confirmado y se clasifica (`duplicate`/`conflict`).

## Garantías (probadas contra MongoDB 8.0.38 local)

- Si falla la escritura de la medición, el claim no sobrevive (M13, M14).
- Si el claim no puede crearse, la medición no se escribe.
- Abort manual y abort tras insertar sin commit no dejan documentos (M14).
- Reintento transitorio no duplica escrituras (M14).
- N procesos concurrentes con la misma clave y fingerprint → exactamente 1 medición (2, 4 y 10 procesos; M11/M12); con fingerprints distintos → 1 persistida y N−1 `conflict` (M12b).
- Sin claims ni mediciones huérfanas; cada par coincide en clave y fingerprint (M19, M20).
- El composer solo llama a `persistAtomically` **después** de la reconciliación A1 con BE-12; un drift aborta antes de cualquier escritura (M18).

No se garantiza: exactly-once global, atomicidad con sistemas fuera de esta base, ni durabilidad ante failover (nodo único).

## Tiempos

- `storedAt` (medición) y `committedAt` (claim): hora técnica del servidor de este store.
- `event.persistedAt`: `persistedAt` **semántico** del `TrustedMeasurementEvent`, aprobado por la política de BE13-04 a partir del candidate. Nunca se reemplaza por la hora del store (verificado en M08).

## Colecciones y esquemas

| Colección | Validador | Documento |
| --- | --- | --- |
| `<prefix>_idempotency` | `$jsonSchema` estricto, `additionalProperties:false`, `validationAction: error` | ver contrato de idempotencia |
| `<prefix>_measurements` | ídem | `_id`, clave lógica, `fingerprint`, `event` (TrustedMeasurementEvent con epoch numéricos), `attribution` (reconciliada), `storedAt` |

`<prefix>` = `agro_ingest_[a-z][a-z0-9_]{0,32}`. Las colecciones solo se crean con `provisionIngestionCollections` (falla si ya existen).

## Índices

| Colección | Nombre | Campos (orden) | Único | Propósito |
| --- | --- | --- | --- | --- |
| idempotency | `_id_` | `_id` | sí (implícito) | lookup puntual por clave hasheada |
| idempotency | `idempotency_key_unique` | realm, sourceId, operation, eventId, field | sí | invariante lógico explícito, independiente de la derivación del hash |
| measurements | `_id_` | `_id` | sí (implícito) | `measurementId` determinista |
| measurements | `measurement_key_unique` | realm, sourceId, operation, eventId, field | sí | como máximo una medición por clave aunque se eludiera el claim |
| BE-11 devices | `device_technical_identity_unique` (existente) | realm, sourceId, keyKind, keyValue | sí | resolución de dispositivo (verificado por `explain`) |
| BE-11 associations | `device_timeline_unique` (existente) | realm, physicalDeviceId, validFrom | sí | resolución histórica (verificado por `explain`) |

No se crearon índices de historial de mediciones: no hay lector todavía (pendiente con la integración de lectura BE-12). Todos usan collation `simple`.
