# BE13-04 — Matriz de compatibilidad ReadyForAttribution → TrustedMeasurementEvent (BE-12)

BE-12 no fue modificado. El evento se valida con `trustedMeasurementEventSchema` real y la prueba #22 lo pasa por `createMeasurementAttributionService.resolve` con dobles, reproduciendo el mismo dueño.

## Campos de `TrustedMeasurementEvent`

| Campo BE-12 | Origen en BE13-04 | Estado |
| --- | --- | --- |
| `eventId` | ready (= candidate) | VERIFICADO |
| `sourceId` | ready | VERIFICADO |
| `device` | ready, revalidado por dispositivo | VERIFICADO |
| `receivedAt` | candidate `timestamps.receivedAt` | DISPONIBLE (metadato de recepción) |
| `declaredAt` | `DeclaredAtPolicy` (valor exacto de un reloj del candidate o `null`) | VERIFICADO por política; BLOQUEADO por defecto |
| `persistedAt` | candidate + `PersistenceTimePolicy`; nulo bloquea | VERIFICADO por política; BLOQUEADO si nulo o por defecto |
| `magnitude` / `unit` | ready, revalidado por catálogo | VERIFICADO |
| `value` | ready (literal) | DISPONIBLE |
| `missingReason` | `null` para números; `MissingReasonPolicy` para `null` | VERIFICADO por política; BLOQUEADO por defecto |
| `provenance` | origen verificado por hardware (`physical`/`simulated`) | VERIFICADO |
| `simulated` | `provenance === 'simulated'` | VERIFICADO (refine BE-12) |
| `metadata` | `{}` | NO_APLICA (sin contrato de metadatos) |

## Datos de atribución (no forman parte del evento)

| BE-12 `AttributionResult` | BE13-04 `attribution` | Estado |
| --- | --- | --- |
| `attributedAt` | `authorizedAt` | PENDIENTE_REVALIDACION: BE-12 lo obtiene de su puerto temporal |
| `clock` | `ClockPolicy` (`received-at` / `declared-at-approved`) | VERIFICADO por política; BLOQUEADO por defecto |
| `physicalDeviceId`, `clientId`, `fieldId`, `areaId`, `sensorId`, `associationId`, `associationRevision`, `realm` | revalidados | PENDIENTE_REVALIDACION en BE-12 |

## Brechas que quedan para la composición (BE13-05 o posterior)

| Brecha | Detalle | Estado |
| --- | --- | --- |
| Contratos de dispositivo distintos | BE-12 `ResolvedPhysicalDevice` no tiene `version`; no puede comparar `revisions.deviceVersion` | PENDIENTE |
| Sin fingerprints en BE-12 | BE-12 solo detecta cambios entre sus dos lecturas | PENDIENTE: la composición debe comparar el `AttributionResult` con `attribution` (ids, revisión, `attributedAt`, `clock`) y cuarentenar si difieren |
| Hardware | BE-12 no tiene puerto de hardware | PENDIENTE |
| Catálogo | BE-12 `accepts({magnitude, unit, provenance})` booleano; compatible con magnitud/unidad aprobadas | DISPONIBLE |
| Realm | BE-12 configura realm en el servicio; coincide con el del builder | VERIFICADO en prueba #22 |
