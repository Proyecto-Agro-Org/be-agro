# BE13-06 — Campaña MongoDB real local

Ejecución: `scripts/be11-local.ps1 -AuthorizeDisposable -Suite be13-06 -Port 27069` → contenedor `mongodb/mongodb-community-server:8.0-ubi8` (MongoDB **8.0.38**), replica set `agro_db02` de un nodo, red bridge propia, publicación solo `127.0.0.1:27069`, tmpfs, base `agro_db02_test_<runId>` vacía y eliminada al final; limpieza de contenedor y red confirmada. Git SHA evaluado: `ede8202` (árbol limpio exigido por el runner).

**Resultado inicial: 27/27 en dos ejecuciones independientes (`ede8202`). Tras la revisión final (A06 validador, A07 planes) y la corrección del validador: 29/29 en dos ejecuciones (`67d0726`).** Evidencia local (no versionada): `.local-evidence/be13-06-mongodb.json` y logs del launcher.

| ID | Escenario | Resultado |
| --- | --- | --- |
| M01 | Resolución por realm + sourceId + clave técnica; `explain` usa `device_technical_identity_unique` | PASS |
| M02 | Dispositivo desconocido → `unresolved-device`; 0/0 escrituras | PASS |
| M03 | Ambigüedad: índice único BE-11 rechaza duplicado (E11000); sin índice, el store reporta 2 y el gate cuarentena `ambiguous-device` | PASS |
| M04 | Misma clave e identidad de asociación en realm `test` y `preview`: cada consulta ve solo su realm; `explain` con realm en los límites del índice | PASS |
| M05 | Asociación histórica cerrada | PASS |
| M06 | A→B→A: 199→A, 200→B, 299→B, 300→A | PASS |
| M07 | Bordes `[validFrom, validTo)`: 99→∅, 100→A1, 199→A1, 200→B | PASS |
| M08 | Primer evento E2E (mapper→gate→builder→BE-12→transacción): `accepted`, `persisted:true`; 1 claim + 1 medición; `storedAt` del servidor ≠ `event.persistedAt` | PASS |
| M09 | Retry exacto (otra recepción) → `duplicate` con el mismo `measurementId`; 1/1 | PASS |
| M10 | Retry alterado → `idempotency-conflict`; 1/1 | PASS |
| M11a | 2 procesos concurrentes, misma clave/fingerprint → 1 `persisted`, 1 `duplicate` | PASS |
| M11 | 4 procesos → 1 + 3 `duplicate` | PASS |
| M12 | 10 procesos → 1 + 9 `duplicate` | PASS |
| M12b | 10 procesos, fingerprints distintos → 1 + 9 `conflict` | PASS |
| M13 | Fallo tras claim, antes de insertar medición → 0 documentos | PASS |
| M14 | Fallo tras insertar sin commit; abort manual; error transitorio en intento 1 → reintento (2 intentos) sin duplicar | PASS |
| M15 | Mismo eventId en realm `preview` → clave independiente; lookup de `test` no responde por `preview` | PASS |
| M16 | Mismo eventId, otro campo → segunda medición | PASS |
| M17 | Mismo eventId y campo, otra fuente → clave distinta | PASS |
| M18 | Drift de atribución (asociación cambiada antes de BE-12) → `attribution-drift`; 0 escrituras | PASS |
| M19 | Sin claims huérfanos (`$lookup`) | PASS |
| M20 | Sin mediciones huérfanas; cada par coincide en clave, fingerprint e id derivado | PASS |
| A01 | Claim manipulado (identidad no coincide) → error; composición `persistence-unavailable` | PASS |
| A02 | Validador rechaza medición incompleta (código 121) | PASS |
| A03 | Documento BE-11 malformado (bypass de validador) → fail-closed | PASS |
| A04 | Asociaciones solapadas → reportadas; gate `overlapping-association` | PASS |
| A05 | Realm forjado en la entrada de persistencia → rechazado sin escribir | PASS |

## Concurrencia observada (intentos de transacción por proceso)

| Escenario | Ejecución 1 | Ejecución 2 |
| --- | --- | --- |
| 2 procesos | 1, 2 | 1, 2 |
| 4 procesos | 2, 1, 2, 2 | 1, 2, 2, 2 |
| 10 procesos | 2,2,2,2,2,2,2,2,1,2 | 2,2,2,2,2,2,2,1,2,2 |

Los segundos intentos son conflictos de escritura reales resueltos por reintento del driver; en todos los casos quedó exactamente 1 medición. Conteos finales: 9 claims / 9 mediciones en ambas ejecuciones.

## Verificación de mutación

Con el claim ejecutado **fuera** de la transacción (mutación sobre `dist`, restaurado después), la campaña falló (10 PASS y luego FAIL en M11a): la pérdida de atomicidad es detectable.

## Revisión final

| ID | Escenario | Antes de la corrección | Después (×2) |
| --- | --- | --- | --- |
| A06 | Validador de mediciones frente a 18 violaciones y 4 documentos válidos | FAIL: 15 violaciones aceptadas | PASS: 0 aceptadas, 0 válidos rechazados |
| A07 | Planes ganadores de idempotencia y mediciones | PASS | PASS |
