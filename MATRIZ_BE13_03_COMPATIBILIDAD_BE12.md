# BE13-03 — Matriz de compatibilidad Candidate → Gate → ReadyForAttribution → BE-12

Clasificación: **DISPONIBLE** (existe en el candidate, sin autoridad), **VERIFICADO** (confirmado por autoridad inyectada en BE13-03), **BLOQUEADO** (no puede producirse sin decisión/autoridad pendiente), **PENDIENTE_REVALIDACION** (verificado, pero BE13-04/BE-12 debe releerlo), **NO_APLICA**.

BE-12 no fue modificado.

## `TrustedMeasurementEvent` (entrada de `createMeasurementAttributionService.resolve`)

| Campo BE-12 | Candidate BE13-02 | ReadyForAttribution BE13-03 | Estado | Observación |
| --- | --- | --- | --- | --- |
| `eventId` | `eventId` | `eventId` | DISPONIBLE | Copia literal |
| `sourceId` | `sourceId` | `sourceId` | DISPONIBLE | No es `clientId` |
| `device` | `device` | `device` | VERIFICADO | Confirmado por autoridad A (clave y fuente exactas) |
| `receivedAt` | `timestamps.receivedAt.value` | `timestamps.receivedAt` | DISPONIBLE | Metadato de recepción, no instante de adquisición |
| `declaredAt` | `deviceTimestamp` / `sentAt` | — | BLOQUEADO | Qué reloj declarado alimenta `declaredAt` no está aprobado; `authorizedAt`+`clock` lo informan pero BE13-03 no decide el mapeo |
| `persistedAt` | `timestamps.persistedAt.value` (nullable) | `timestamps.persistedAt` (nullable) | BLOQUEADO | BE-12 exige número; si es `null` la conversión debe esperar persistencia |
| `magnitude` | — (clave técnica de payload) | `magnitude` | VERIFICADO / PENDIENTE_REVALIDACION | Solo catálogo inyectado; `catalogueRevision` capturada |
| `unit` | — | `unit` | VERIFICADO / PENDIENTE_REVALIDACION | Sin conversión |
| `value` | `payload[field]` | `value` | DISPONIBLE | 0 y `null` preservados |
| `missingReason` | — | — | BLOQUEADO | BE-12 exige motivo si `value=null`; no se infiere (`absent`, `invalid`, … requieren semántica aprobada) |
| `provenance` | `dataOriginDeclared` | `provenance.hardware.origin` | VERIFICADO (parcial) | `physical`/`simulated` provistos por autoridad E; `derived/estimated/manual/laboratory` no aplican a este flujo |
| `simulated` | `dataOriginDeclared` | `provenance.hardware.origin` | VERIFICADO | Debe coincidir con `provenance==='simulated'` |
| `metadata` | `topic`, etc. | — | NO_APLICA | No se trasladan metadatos sin contrato |

## `AttributionResult` verificado (salida BE-12)

| Campo BE-12 | ReadyForAttribution | Estado | Observación |
| --- | --- | --- | --- |
| `attributedAt` | `authorizedAt` | PENDIENTE_REVALIDACION | BE-12 obtiene su propio instante de su puerto temporal; debe coincidir con `authorizedAt` y `temporalPolicyRevision` |
| `clock` | `clock` | BLOQUEADO | BE-12 admite `received-at`/`declared-at-approved`; BE13-03 distingue `device-declared-approved` y `broker-declared-approved`. La correspondencia requiere decisión |
| `physicalDeviceId` | `physicalDeviceId` | PENDIENTE_REVALIDACION | Revisión `deviceVersion` |
| `realm` | `realm` | VERIFICADO | Todas las autoridades responden en el mismo realm |
| `clientId` | `clientId` | PENDIENTE_REVALIDACION | Solo de la asociación histórica |
| `fieldId` / `areaId` / `sensorId` | idem | PENDIENTE_REVALIDACION | Idem |
| `associationId` | `associationId` | PENDIENTE_REVALIDACION | |
| `associationRevision` | `revisions.associationRevision` + `fingerprints.association` | PENDIENTE_REVALIDACION | Comparar revisión y huella al releer (BE13-03A) |

## Diferencias de modelo a resolver en BE13-04

| Tema | BE-12 | BE13-03 | Estado |
| --- | --- | --- | --- |
| Contrato de dispositivo | `ResolvedPhysicalDevice` (sin `version`) | `PhysicalDevice` BE-11 (con `version`) | PENDIENTE_REVALIDACION — BE-12 no puede comparar versión |
| Ventana de asociación | `AttributionWindow` (con `realm`) | `SensorDeviceAssociation` BE-11 + `realm` en sobre | Equivalente en campos de atribución |
| Hardware | No existe puerto | Puerto E separado | BLOQUEADO hasta que BE-12/BE13-04 lo exija |
| Catálogo | `accepts({magnitude, unit, provenance})` booleano | `evaluate(field…)` → magnitud/unidad aprobadas + revisión | Compatible: el resultado de BE13-03 alimenta `accepts` |
| Revalidación | Doble lectura interna (`CONFLICT`) | Doble lectura interna + `revisions` + `fingerprints` + `revalidation:'required'` | Coherente; ninguna de las dos elimina TOCTOU posterior |
| Sesión de ingesta | — | — | NO_APLICA hoy; no existe revisión de sesión de ingesta en el código |

## Conclusión

`ReadyForAttribution` **no puede convertirse hoy** en `TrustedMeasurementEvent` válido sin decisiones sobre `declaredAt`, `missingReason`, `persistedAt` nulo y el mapeo de `clock`. Esa conversión corresponde a BE13-04 y no se implementa aquí.
