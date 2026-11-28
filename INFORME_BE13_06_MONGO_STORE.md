# BE13-06 — Store Mongo de ingesta y persistencia atómica

## Resumen

Resuelve C3 (implementación Mongo de `IngestionIdentityStore`) y C4 (claim de idempotencia + escritura de medición en una única transacción), probados contra **MongoDB 8.0.38 real local** (replica set de un nodo en contenedor Docker desechable, solo `127.0.0.1`). Sin Atlas, EMQX, hardware ni Production. No montado en `app.ts`.

- Rama `feature/be13-06-mongo-ingestion-store`, worktree `.local-consolidacion/be13-06`.
- Base `origin/dev` `8949223c035693c7f6860106cd93d953007aa6c0` (merge de BE13-05, PR #25).
- Commit de implementación evaluado por la campaña: `ede820213b8fe26f78996f6d01f84f4417d44896`.

## Arquitectura

| Archivo | Rol |
| --- | --- |
| `src/repositories/mongo-ingestion-identity.store.ts` | C3: store sobre colecciones BE-11 |
| `src/repositories/mongo-measurement-persistence.repository.ts` | C4: `lookup` + `persistAtomically` |
| `src/models/ingestion-persistence.models.ts` | Colecciones, validadores, índices, aprovisionamiento explícito |
| `src/iot/ingestion-composition.contracts.ts` / `.schemas.ts` | `MeasurementPersistencePort`, resultados persistentes |
| `src/services/measurement-ingestion-composition.service.ts` | Nueva factory `createPersistentMeasurementIngestionComposition` (modo `persist`); modo `claim` BE13-05 sin cambios (53/53) |
| `scripts/audit-be13-06-mongodb-local.ts`, `scripts/be13-06/*` | Campaña real, guard de destino, worker de concurrencia |
| `scripts/be11-local.ps1` | Se agrega el runner fijo `be13-06` (prueba de guarda del launcher actualizada) |

## C3 — IngestionIdentityStore Mongo

- Lee los mismos documentos que escribe BE-11 (`DeviceDocument`, `AssociationDocument`; nombres vía `sensorCollections`). No escribe ni rodea reglas BE-11; no recibe `clientId` del payload.
- Dispositivo: filtro `{realm, sourceId, keyKind, keyValue}`, límite 2 (ambigüedad reportada, nunca elegida). El índice único BE-11 `device_technical_identity_unique` hace imposible la ambigüedad dentro de un realm (M03 lo prueba) y `explain` confirma su uso.
- Asociación: `{realm, physicalDeviceId, validFrom ≤ t, (validTo = null ∨ t < validTo)}` = `[validFrom, validTo)`, orden `validFrom`, límite 2. Usa `device_timeline_unique`.
- **Realm en la query**, nunca como post-filtro (pruebas offline sobre el filtro + `explain` real).
- Fechas BE-11 → epoch ms; documentos malformados → error (fail-closed).
- Supuesto: los documentos BE-11 ya llevan `realm`; no se modificó el modelo BE-11.

## C4 — Persistencia atómica

Ver `CONTRATO_BE13_06_ATOMIC_PERSISTENCE.md` y `CONTRATO_BE13_06_IDEMPOTENCIA.md`. El composer persistente llama a `persistAtomically` solo después de gate, builder, BE-12 y reconciliación A1.

## Realm y BE-12

La composición persistente construye BE-12 con `createBe12IdentityPorts(store Mongo, realm)`: el realm es explícito y se aplica en el almacenamiento; la API pública de BE-12 no cambió.

## `persistedAt`

Se separan `storedAt`/`committedAt` (hora técnica del store) del `event.persistedAt` semántico aprobado por política. No se usa la hora de Mongo como `persistedAt` del evento.

## Guard de destino

`assertLocalMongoUri` + `assertLocalReplicaSetHello` + guard existente DB02: solo `mongodb://127.0.0.1:<puerto>/agro_db02_test_<runId>?directConnection=true&replicaSet=agro_db02`; se rechaza `mongodb+srv`, dominios Atlas/nube, hosts externos, credenciales, TLS, discovery, mongos y miembros remotos. Además se verifican contenedor, red, tmpfs y binding loopback propios.

## Limitaciones

- Nodo único: sin failover ni pruebas de elección.
- Autoridades y políticas sintéticas en la campaña.
- `DEVICE_STATUS_HISTORY_REQUIRED` sigue BLOQUEADO: un dispositivo hoy inactivo bloquea (fail-closed).
- Sin índices de lectura de historial de mediciones (no hay lector aún).
- No hay composición en runtime ni bootstrap.

## Estado

| Categoría | Elementos |
| --- | --- |
| IMPLEMENTADO | Store Mongo C3, persistencia atómica C4, composición persistente, campaña, guard |
| PROBADO | Offline 687/687 (23 nuevas); Mongo real 27/27 en dos ejecuciones; mutación de atomicidad detectada; HTTP 13/13 |
| PENDIENTE | Bootstrap/composition root productivo; índices de lectura; failover |
| BLOQUEADO | Políticas productivas, historial de estado de dispositivo, catálogo BE-04, hardware, Atlas/EMQX |
| NO VERIFICABLE | Comportamiento en Atlas/multi-nodo; código hostil en proceso |
