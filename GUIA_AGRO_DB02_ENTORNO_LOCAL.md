# AGRO-DB-02 — Entorno local exclusivo y ejecución

19/11/2026. **Ejecución real completada con Docker Desktop:**15/15 en standalone y15/15 en
replica set de un nodo, MongoDB8.0.38. Se corrigieron defectos del launcher/harness al ejecutarlos.
Ver [informe de ejecución](INFORME_AGRO_DB02_EJECUCION_REAL_DOCKER.md). La
[matriz anterior](MATRIZ_AGRO_DB02_RESULTADOS.md) conserva el estado histórico previo sin servidor.

## Requisitos y autorización

- Docker Desktop/Engine Linux funcionando sobre IPC local, con memoria/CPU suficientes e Internet
  permitido para descargar una imagen pública oficial; no login de registro ni secretos reales.
- Operador debe confirmar que el daemon corresponde al equipo y que no hay proxy/túnel ajeno.
  Se rechazan endpoints Docker TCP/SSH aunque usen localhost. No reutilizar un MongoDB ya abierto.
- Ejecutar solo en el worktree dev autorizado, preservando DB01. No usar .env/URI de otro proyecto.
- Imagen verificada `mongodb/mongodb-community-server:8.0-ubi8`, versión efectiva8.0.38,
  digest sha256:9d0a9018ce342fec9c879a4d45525f45431c398fbea9d48b4ea0e656fdd274b1.
  El tag puede cambiar; registrar imageId y versión buildInfo de cada ejecución. Si no es accesible,
  el launcher falla sin sustituir silenciosamente por otra imagen.
- MongoDB requiere CPU compatible. No instalar versiones EOL para eludir un problema de hardware.

Referencia primaria de imagen/flags/hello: [documentación oficial MongoDB Docker](https://www.mongodb.com/docs/v8.0/tutorial/install-mongodb-community-with-docker/).
Los flags y restricciones adicionales de esta guía son decisiones de aislamiento de AGRO-DB-02.

## Ejecución reproducible

PowerShell, desde `.local-consolidacion/dev`:

```powershell
npm ci
if ($LASTEXITCODE -ne 0) { throw 'npm ci falló' }
npm run typecheck
if ($LASTEXITCODE -ne 0) { throw 'typecheck falló' }
npm run build
if ($LASTEXITCODE -ne 0) { throw 'build falló' }
npm test
if ($LASTEXITCODE -ne 0) { throw 'offline falló' }
# Cada llamada crea una ejecución nueva; nunca reutiliza la DB anterior.
& .\scripts\agro-db02-local.ps1 -AuthorizeDisposable -Topology standalone -Port 27029
# Solo después de revisar el resultado/limpieza de standalone:
& .\scripts\agro-db02-local.ps1 -AuthorizeDisposable -Topology single-node-replica-set -Port 27029
```

No cambiar políticas globales de PowerShell ni instalar Docker automáticamente si falta.
El launcher falla ante ausencia de Docker, daemon/contexto remoto, puerto ocupado, pull o readiness
fallidos. No prueba puertos alternativos ni se conecta al servicio que pudiera ocupar el puerto.

El servidor replica set anuncia localhost:27017 dentro de su contenedor; el driver del host usa
127.0.0.1:puerto-publicado y directConnection=true. No sigue discovery hacia esos peers.
El hello además debe indicar el set agro_db02/primary y no anunciar hosts remotos ni mongos.
Se usa family4; no DNS, SRV, credenciales, TLS/proxy ni URI arbitraria.

## Recursos y aislamiento

El [launcher](scripts/agro-db02-local.ps1) genera runId aleatorio de24 hex y crea:

| Recurso | Alcance y nombre |
| --- | --- |
| Imagen pública | Caché Docker de la imagen solicitada; no se elimina ni poda caché compartida |
| Red | agro-db02-runId; bridge exclusivo, gateway NAT, binding por defecto127.0.0.1 y masquerade deshabilitado; label agro.db02.run, ningún contenedor ajeno admitido |
| Contenedor | agro-db02-runId, ID exacto; mismo label, sin privileged ni bind mounts |
| Puerto | Solo127.0.0.1:27029→27017; guardia verifica binding efectivo y ausencia de otros puertos |
| Almacenamiento | tmpfs propios /data/db1024MiB y /data/configdb32MiB, mode1777 para mongod no-root; no volúmenes persistentes/reutilizados |
| Límites |1536MiB RAM,1 CPU; readiness45 intentos y primary30; suite con supervisor180s, carreras45s y workers30s |
| Base | agro_db02_test_runId, inicialmente sin colecciones; ninguna URI/base existente aceptada |

Siete colecciones fixture: agro_auth_db02_users, agro_auth_db02_clients, agro_auth_db02_sessions,
agro_auth_db02_challenges, db02_business_associations, db02_ingest_devices y db02_ingest_measurements.
Los prefijos separan dominios de fixture; no son nombres productivos ni una prueba de permisos
RBAC entre servicios. Usuarios/clientes/auth reutilizan modelos existentes, no un catálogo nuevo.

`AGRO_DB02_ENABLE=AUTHORIZED_DISPOSABLE_DB02_ONLY`, RUN_ID, CONTAINER, PORT y TOPOLOGY son
temporales y restaurados por el launcher. Guard.ts rechaza AGRO_DB02_URI/HOST/DATABASE; MONGODB_URI
preexistente se ignora y nunca se imprime. Un opt-in sin inspect/red verificados no permite conectar.
El runner se ejecuta separadamente, nunca como prueba positiva de npm test ni desde app/server.

Corrección de ejecución real: en Docker29.9.3 la red internal conservaba PortBindings solicitados
pero dejaba NetworkSettings.Ports vacío y el host recibía ECONNREFUSED. El launcher usa ahora el
bridge exclusivo descrito arriba y exige publicación efectiva idéntica a127.0.0.1:puerto solicitado.
Comprueba HostConfig.Tmpfs y también /proc/mounts dentro del contenedor; --tmpfs puede no aparecer
en Mounts del inspect. Estas correcciones no autorizan conectarse a otra base ni exponer puertos públicos.

## Evidencia y limpieza propia

Directorio fuera del árbol de publicación del worktree:
`../integraciones/agro-db02-20261119/`.

- resources-runId.json: recursos creados, imagen solicitada, puerto, topología y limpieza.
- results-runId.jsonl: versión, imageId, índices consultados, resultados R01–R15, PIDs de carreras,
  resumen y objetos retirados. Sin tokens/URI/cuerpos personales. Fixtures son sintéticos.
- Leer todos los eventos y el exit code; un resumen parcial no significa suite aprobada.

El runner elimina **solo las colecciones que creó**, con namespace/lista permitida y ownership
reverificado, después comprueba ausencia de colecciones. No usa dropDatabase. El launcher retira
solo su contenedor/red verificando ID/label y red vacía; nunca prune, rm global, borrado de backups
ni eliminación de imágenes/volúmenes desconocidos. tmpfs desaparece al retirar el contenedor.

Si timeout/kill/interrupción impide finally: conservar el manifiesto. Inspeccionar manualmente
ese ID y label con docker inspect y docker network inspect, confirmar ownership y que no hay
contenedores ajenos, y retirar exclusivamente esos IDs. No ejecutar el harness contra otro servidor
para limpiar una DB por coincidencia de nombre. No afirmar limpieza confirmada sin evidencia.
Un worker interrumpido puede tardar hasta su deadline30s en salir; verificar procesos propios.

## Después de una ejecución positiva

Exigir versión/topología reales,15 casos aprobados, dos PIDs distintos por carrera, índices
efectivos y limpieza confirmada. Si falla, detenerse, preservar evidencia y corregir un defecto
reproducible antes de repetir con otra ejecución nueva. La suite usa reloj inyectado para pruebas
de vencimiento lógico; no espera que TTL borre exactamente al vencer.

Faltan campañas separadas de durabilidad con almacenamiento descartable persistente, restart,
failover multinodo y particiones reales. No usar este tmpfs para afirmar tolerancia a fallos.
Antes de Atlas/Preview: cerrar inventario BSON/IDs/permisos, autenticación/procedencia IoT y handoff,
contratos FE/GIS y aprobación de activación. Este trabajo no habilita login, BE-10 ni deploys.
