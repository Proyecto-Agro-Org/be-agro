# INFORME BE13-11Q — Recuperación integrada de la reconciliación ante pérdida real de mayoría de Mongo

Estado: `LOCAL_LAB_EVIDENCE`. `productionReady=false`. Una campaña local (Mongo de 3 nodos descartable, sin broker): `.local-evidence/be13-11q-recovery.json`.

## Pregunta
Si el almacén de evidencia pierde la mayoría **mientras** el publisher reconcilia, ¿la API sigue fail-closed y el publisher converge después, sin confirmar de más ni duplicar? (Hasta aquí el camino `pending` solo se había probado con dobles en memoria.)

## Resultado (5/5)
| Fase | Observado |
|---|---|
| línea base sana | evento durable ⇒ `received-durable`; desconocido ⇒ `not-found` |
| mayoría perdida, primario aún activo | el evento **ya durable (majority)** sigue siendo confirmable (`received-durable`, 11 ms): `readConcern: majority` sirve el último snapshot majority — correcto, no es `pending`. Un evento escrito **durante** la pérdida (la escritura `w:majority` expira: *operation exceeded time limit*) **no se confirma** (`not-found`) aunque el primario lo tenga localmente |
| primario degradado (sin primario) | las tres consultas responden **`pending`** en ~4,0 s (límite de lectura de evidencia), incluso para el evento durable: fail-closed y acotado |
| publisher durante la caída | los 3 eventos siguen `PENDING` (`lastConfirmation=pending`), mismos `eventId`; ninguno `CONFIRMED` |
| tras el heal | los 3 convergen a `CONFIRMED`; en el inbox queda 1 registro por evento (el registro no majority de `q-during` se revirtió y la republicación creó el definitivo): sin duplicados |

## Hallazgo y corrección
**MEDIUM (resuelto):** sin primario, una lectura del driver puede esperar la selección de servidor mucho más que cualquier publisher; el servicio de confirmación ahora **acota cada lectura de evidencia** (`evidenceTimeoutMs`, 4 s por defecto, validado 1 ms–60 s): una fuente que no responde a tiempo es `unavailable` ⇒ `pending`. Test J25 (fuente colgada ⇒ `pending` dentro del límite, nunca confirmado). Confirma además la corrección de 11G: lo que solo el primario conoce no es un hecho.

## Cobertura de recuperación del ciclo
Crash del publisher (11N), reinicio del broker y del consumer, failover de Mongo y outage de Mongo sin mayoría (11F/11G/11H/11I/11J/11N), endpoint de reconciliación no disponible / pérdida de mayoría durante la reconciliación (11Q). No se repitieron campañas previas.

## Límites
El valor de 4 s es un default técnico, no una política aprobada; la latencia observada de `pending` coincide con él. No se probó un crash del proceso del backend de confirmación (es stateless: sin estado propio que recuperar).
