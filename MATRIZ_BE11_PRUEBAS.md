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
| Regresión general | suite completa | 388/388 |
| HTTP legacy | health, CORS, 404 y 500 contra base | 13/13 |

Las 388 pruebas incluyen las 374 heredadas, 8 pruebas del núcleo BE-11 y 6 regresiones del launcher: clasificación sanitizada, errores hostiles, creación del directorio de evidencia, cronología válida de M06/M15, readiness acotado en Windows y captura de diagnóstico antes de limpiar.

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

Una primera ejecución local externa llegó al runner pero falló antes de M06. La causa comprobada por inspección fue un fixture temporal inválido: la asociación se abría antes que la asignación sensor-área. No hubo evidencia de éxito. La siguiente ejecución generará, según corresponda:

- `.local-evidence/be11-mongodb.json` para 15/15 aprobados;
- `.local-evidence/be11-mongodb-failure.json` con etapa y categoría sanitizadas;
- `.local-evidence/be11-launcher-<runId>.log` con la salida del runner;
- `.local-evidence/be11-launcher-<runId>.json` con estado del launcher y limpieza.

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
