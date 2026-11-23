# Matriz de pruebas BE-11

## Offline ejecutadas

| Área | Evidencia | Resultado |
|---|---|---|
| Zod | propiedad/estado interno, tipos y claves técnicas rechazados | APROBADO |
| Autorización | scope derivado de capability y contexto forjado rechazado | APROBADO |
| Verificación física | resultado solo desde puerto confiable; fallos sanitizados | APROBADO |
| DTO | mappers explícitos sin campos Mongo/propiedad interna | APROBADO |
| Modelos | sin DDL/conexión al importar; identidad lógica/física separada | APROBADO |
| Aislamiento público | rutas BE-11 devuelven 404 en `createApp()` | APROBADO |
| Regresión general | suite completa | 391/391 |
| HTTP legacy | health, CORS, 404 y 500 contra base | 13/13 |

Las 391 pruebas incluyen las 374 heredadas, 8 pruebas del núcleo BE-11 y 9 regresiones del launcher/guard: clasificación sanitizada, errores hostiles, creación del directorio de evidencia, cronología válida de M06/M15, readiness acotado en Windows, captura de diagnóstico antes de limpiar, contrato de nombre de red, política explícita de red y códigos controlados para cada control de aislamiento.

## MongoDB real ejecutada

El arnés `scripts/be11-local.ps1` crea un contenedor MongoDB Community 8.0 oficial, red exclusiva, binding `127.0.0.1`, dos tmpfs, base/namespace únicos y replica set local de un nodo. Solo elimina recursos con la etiqueta exacta de la ejecución.

| Caso | Cobertura | Estado verificado |
|---|---|---|
| M01 | sensor + asignación inicial | APROBADO |
| M02 | aislamiento cliente/jerarquía | APROBADO |
| M03 | BSON e IDs únicos | APROBADO |
| M04 | dispositivo no verificado | APROBADO |
| M05 | identidad técnica única | APROBADO |
| M06 | asociación half-open | APROBADO |
| M07 | solapamiento | APROBADO |
| M08 | CAS entre conexiones | APROBADO |
| M09 | cierre/apertura atómicos | APROBADO |
| M10 | historia preservada | APROBADO |
| M11 | traslado implícito bloqueado | APROBADO |
| M12 | área y descomisionamiento | APROBADO |
| M13 | carrera con baja BE-10 | APROBADO |
| M14 | `clear/unknown` fail-closed | APROBADO |
| M15 | dos procesos asociando el mismo dispositivo | APROBADO |

La evidencia local excluida de Git registra MongoDB 8.0.38, topología `single-node-replica-set`, `runId` `3369faf5f1f94f7ca1b2be55`, exactamente M01–M15 sin duplicados, 15 estados `passed`, los índices esperados en cinco namespaces y limpieza confirmada. El JSON fue generado después del commit `8bbd890b28ab5dee5b35cf88e24dee05836f98f7`; no contiene un campo SHA embebido, limitación registrada para futuras campañas.

## Condición de cierre

Antes de integrar BE-11 se recomienda ejecutar:

```powershell
npm ci
npm run build
powershell -ExecutionPolicy Bypass -File scripts/be11-local.ps1 -AuthorizeDisposable
npm test
npm run typecheck
git diff --check
```

La campaña real produjo 15/15 y confirmó limpieza de sus recursos. Un nodo no demuestra failover ni tolerancia a fallos distribuida.
