# BE13-06A — Auditoría de seguridad y transacciones

## Método

Revisión de código, 8 vectores adversariales offline, 5 vectores adversariales y 20 escenarios contra MongoDB 8.0.38 real (dos ejecuciones), concurrencia con procesos reales (2, 4, 10) y mutación de atomicidad (claim fuera de la transacción → campaña falla).

## Hallazgos

| ID | Severidad | Descripción | Evidencia | Acción | Estado |
| --- | --- | --- | --- | --- | --- |
| T1 | MEDIO (harness) | El protocolo IPC inicial de la campaña enviaba la configuración al hijo antes de que registrara su listener: el mensaje podía perderse y el worker colgarse. No afectaba código de producción. | Revisión previa a la primera ejecución | Protocolo `ready → setup → armed → go`, listener registrado antes de anunciar cada estado | CORREGIDO |
| T2 | BAJO (pruebas) | Dos casos offline eran vacíos: un documento con otro realm o `keyKind` ya era excluido por el filtro, y un parámetro por defecto ocultaba la ausencia de `persistence`. | Fallos iniciales analizados caso por caso | Casos reemplazados por documentos que llegan al mapeo; `persistence: undefined` explícito | CORREGIDO |
| T3 | BAJO | La guarda del launcher fijaba `ValidateSet('be11','be12')`; el nuevo runner la rompía. | `be11-launcher.test.js` | Guarda actualizada a la lista cerrada `be11/be12/be13-06` con runner fijo verificado | CORREGIDO |
| T4 | MEDIO (arquitectónico) | Nodo único: no se probó failover, `UnknownTransactionCommitResult` real ni rollback por elección. | Topología | Documentado | NO VERIFICABLE localmente |
| T5 | BAJO | Si BE-11 perdiera su índice único de identidad técnica, la ambigüedad sería posible; el store la reporta y el gate la cuarentena (M03). | Campaña | Ninguna (defensa en profundidad ya presente) | SIN DEFECTO |

No se encontraron defectos CRÍTICOS ni ALTOS en el código de producción.

## Búsqueda específica

| Riesgo | Resultado |
| --- | --- |
| Claim huérfano | Ninguno (M13, M14, M19) |
| Medición huérfana | Ninguna (M20); además índice único por clave en mediciones |
| Duplicado incorrecto | Retry exacto → `duplicate` solo con igual fingerprint (M09, M11, M12) |
| Lost update / carrera | Conflictos de escritura reales reintentados; exactamente 1 medición (M11, M12, M12b) |
| Phantom duplicate | Snapshot + clave única; reintento del driver no duplica (M14) |
| Colisión cross-realm | Realm en `_id`, en índices y en filtros (M04, M15, A05) |
| Conflicto en retry | Fingerprint distinto → `conflict` sin escritura (M10, M12b) |
| Reintento de transacción duplicado | El callback reinicia su resultado; conteos +1/+1 tras reintento (M14) |
| Documento de claim manipulado | Identidad verificada contra la clave → fail-closed (A01) |
| Documento Mongo malformado | Esquema estricto en lectura (A03, offline) y validador en escritura (A02) |
| Inyección NoSQL / clave maliciosa | Esquemas `logicalKey`/enum antes de construir filtros (offline V2, store) |
| Asociación cross-client / solapada | Reportada, nunca elegida (A04, V7) |

## Trust boundaries

- El guard de destino y el launcher son la frontera de la campaña: solo loopback, replica set propio, contenedor/red/tmpfs verificados.
- Los repositorios no leen variables de entorno ni contienen URIs (verificado estáticamente).
- WeakSet/WeakMap siguen siendo procedencia en proceso; políticas/autoridades sintéticas no son autenticación; el trust boundary productivo será el bootstrap.

## Dependencias

Sin dependencias nuevas. Se usa el driver incluido en `mongoose` 9.12.2 (`mongoose.mongo` solo en la campaña para construir un error transitorio). Sin secretos, sin URIs hardcodeadas en `src/`, sin conexiones externas.

## Validaciones

Offline 687/687 · Mongo real 27/27 ×2 · HTTP 13/13 · typecheck/build/diff-check OK.

## Revisión final pre-publicación

| ID | Severidad | Hallazgo | Evidencia | Corrección | Estado |
| --- | --- | --- | --- | --- | --- |
| T6 | MEDIO (defensa en profundidad) | El `$jsonSchema` de mediciones aceptaba 15 violaciones del contrato BE-12: `NaN`/`±Infinity` en `value`, `value=null` sin `missingReason`, `0` con `missingReason`, épocas infinitas o fraccionarias, `persistedAt < receivedAt`, `simulated` incoherente con `provenance`, `metadata` anidada, revisión fraccionaria, realm/`eventId`/`sourceId` distintos entre nivel superior y anidado. El código valida con Zod antes de escribir; solo escrituras que eludan el repositorio podían persistirlas. | A06 contra MongoDB 8.0.38 (`acceptedInvalid` con 15 casos) | Rangos finitos, épocas enteras `[0, 8.64e15]`, revisiones enteras, `metadata` escalar (≤ 20), `$expr` con invariantes cruzados BE-12 y coherencia de clave | CORREGIDO (A06: 0 aceptados, 0 válidos rechazados, ×2) |

Planes ganadores (A07 + M01/M04): lookup de claim por `_id` → `FETCH > IXSCAN _id_`; claim por clave → `idempotency_key_unique`; medición por clave → `measurement_key_unique`; dispositivo → `device_technical_identity_unique`; asociación → `device_timeline_unique` con `realm` en los límites.

Launcher `be11-local.ps1`: lista cerrada (`ValidateSet` + `switch` con rutas literales), `$Port` con rango, sin argumentos arbitrarios hacia `node`, guards BE-11 sin cambios, limpieza confirmada por etiqueta de propiedad. Observación preexistente: la suite no tiene timeout global en el launcher (solo readiness y carreras).

Campaña tras la corrección: **29/29 en dos ejecuciones** (`67d0726`).
