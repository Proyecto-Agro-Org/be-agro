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
| Regresión general | suite completa | 382/382 |
| HTTP legacy | health, CORS, 404 y 500 contra base | 13/13 |

Las 382 pruebas incluyen las 374 heredadas y 8 pruebas nuevas BE-11.

## MongoDB real preparada

El arnés `scripts/be11-local.ps1` crea un contenedor MongoDB Community 8.0 oficial, red exclusiva, binding `127.0.0.1`, dos tmpfs, base/namespace únicos y replica set local de un nodo. Solo elimina recursos con la etiqueta exacta de la ejecución.

| Caso | Cobertura | Estado de esta sesión |
|---|---|---|
| M01 | sensor + asignación inicial | NO EJECUTADO |
| M02 | aislamiento cliente/jerarquía | NO EJECUTADO |
| M03 | BSON e IDs únicos | NO EJECUTADO |
| M04 | dispositivo no verificado | NO EJECUTADO |
| M05 | identidad técnica única | NO EJECUTADO |
| M06 | asociación half-open | NO EJECUTADO |
| M07 | solapamiento | NO EJECUTADO |
| M08 | CAS entre conexiones | NO EJECUTADO |
| M09 | cierre/apertura atómicos | NO EJECUTADO |
| M10 | historia preservada | NO EJECUTADO |
| M11 | traslado implícito bloqueado | NO EJECUTADO |
| M12 | área y descomisionamiento | NO EJECUTADO |
| M13 | carrera con baja BE-10 | NO EJECUTADO |
| M14 | `clear/unknown` fail-closed | NO EJECUTADO |
| M15 | dos procesos asociando el mismo dispositivo | NO EJECUTADO |

### Bloqueo real

Los comandos `docker version`, `docker info` y `docker ps` no pudieron comenzar: `docker` no existe en PATH, no se encontró `docker.exe` en la instalación estándar y tampoco existe el servicio `com.docker.service`. No se crearon contenedores, redes, volúmenes ni bases. Por ello no se informa versión MongoDB real ni se afirma aprobación transaccional.

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

La campaña real debe producir 15/15 y confirmar limpieza de sus recursos. Un nodo no demuestra failover ni tolerancia a fallos distribuida.
