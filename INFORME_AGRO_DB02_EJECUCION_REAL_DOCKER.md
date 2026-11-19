# AGRO-DB-02 — Ejecución real con Docker Desktop

19/11/2026. Proyecto-Agro-Org/be-agro, rama dev, HEAD/origin-dev
`c8aed23165edffa647b7230dae6cc738031c9483`, integración PR#16.
**Resultado:15/15 casos en standalone y15/15 en replica set local de un nodo.**
Se reutilizó la campaña existente; no otra suite desde cero. Autenticación productiva y
telemetría comercial permanecen deshabilitadas. No Atlas, Google real, Preview ni deploys.

## 1. Entorno autorizado y alcance

Worktree real: `C:\Users\CamilaGonzález\be-agro\.local-consolidacion\dev`.
La variante be-agro.local-consolidacion indicada en el pedido no existe; se continuó en el
worktree existente y verificado. Árbol inicialmente limpio,153 archivos con hashes iniciales.
Main conserva `1bb20f76b7a739f42c75b37b9a64315276560ec1`.

Docker Desktop4.100.0 (246961), CLI/Engine29.9.3, contexto desktop-linux, servidor linux/amd64,
WSL2,7,43GiB de RAM disponibles para el motor. `docker version`, `info` y `ps` ejecutados desde
PowerShell. El CLI no estaba en el PATH de esta sesión: se añadió su carpeta de instalación
solo al entorno de procesos, sin editar configuración global. Docker se accedió por named pipe
local npipe:////./pipe/dockerDesktopLinuxEngine, sin daemon remoto.

Inventario inicial:0 contenedores,0 imágenes,0 volúmenes; redes bridge/host/none. Puerto27029 sin
listener detectado. No se reutilizó ningún recurso. Se descargó de la fuente oficial la imagen
`mongodb/mongodb-community-server:8.0-ubi8`, digest/imageId
`sha256:9d0a9018ce342fec9c879a4d45525f45431c398fbea9d48b4ea0e656fdd274b1`.
MongoDB reportó **8.0.38** mediante buildInfo. Mongoose9.12.2 y driver del lock existente;
Node24.19.0, TypeScript5.9.3. Sin dependencias nuevas ni credenciales del proyecto.

## 2. Aislamiento comprobado y recursos

Cada intento generó runId, contenedor y red nuevos con label agro.db02.run. DB exclusivamente
agro_db02_test_runId. La guardia comprobó contexto local, ownership, imagen, red exclusiva,
ausencia de contenedores ajenos/privileged/binds/volúmenes y publicación efectiva127.0.0.1:27029.
No carpetas personales montadas ni URI MongoDB preexistente. Driver literal loopback/family4/
directConnection, sin discovery remoto; hello valida la topología y rechaza hosts ajenos.

Configuración final: bridge exclusivo, gateway NAT, default binding127.0.0.1 y masquerade=false;
dos tmpfs: /data/db1024MiB y /data/configdb32MiB, mode1777 para mongod no-root. Se verificaron
HostConfig.Tmpfs y montajes efectivos mediante /proc/mounts. RAM limitada1536MiB,1CPU.
Sin cambios de daemon/firewall/Vercel. Publicación loopback documentada en
[Docker](https://docs.docker.com/engine/network/port-publishing/); el fallo de red internal se
constató en este equipo, no se infirió solamente de documentación.

| Corrida final | Standalone | Replica set local |
| --- | --- | --- |
| RunId | 0dd533bbe48941768037fdf6 | e2733631e6f44f0a9d6df31d |
| Contenedor | 5f109156625267e1c88a1cd377368a6461b8703d5accb7d011fc4b402297b8dd | 586df63e258839922996b5d5c5bd2695523f924d555d4622d0123b948b4e2d6f |
| Red | agro-db02-0dd533bbe48941768037fdf6 | agro-db02-e2733631e6f44f0a9d6df31d |
| Base fixture | agro_db02_test_0dd533bbe48941768037fdf6 | agro_db02_test_e2733631e6f44f0a9d6df31d |
| Topología comprobada | Sin setName | agro_db02, un miembro, primary |
| Resultados |15 aprobados,0 fallidos,0 omitidos |15 aprobados,0 fallidos,0 omitidos |
| Limpieza | Colecciones propias eliminadas y verificación vacía; contenedor/red retirados | Igual |

La separación empresarial/IoT usa prefijos de fixtures dentro de cada DB exclusiva; no demuestra
RBAC por servicio ni aprueba nombres físicos de Atlas. No hubo migraciones de datos existentes.

## 3. Índices observados en MongoDB real

**18 índices por corrida**, consultados con listIndexes sobre siete colecciones. Incluyen _id_
en cada una y11 índices explícitos; creación previa a cualquier caso de negocio y sin autoDDL.

| Colección fixture | Índices adicionales a _id_ / comprobación |
| --- | --- |
| agro_auth_db02_users | auth_user_id_unique (realm/id), auth_principal_unique (realm/issuer/subject), auth_membership_lookup |
| agro_auth_db02_clients | auth_client_id_unique (realm/id) |
| agro_auth_db02_sessions | auth_session_digest_unique (realm/digest), auth_session_expiry TTL |
| agro_auth_db02_challenges | auth_challenge_expiry TTL; unicidad del challenge por _id realm:digest |
| db02_business_associations | Lookup jerarquía por realm/clientId/fieldId/areaId/sensorId/validFrom; lookup técnico realm/sourceId/device.kind/device.value/validFrom |
| db02_ingest_devices | db02_device_unique (sourceId/clientid) |
| db02_ingest_measurements | db02_history (clientid, _receivedAt desc, _id desc) |

R01 conservó las opciones/keys/nombres reales en JSONL. R02/R03/R14 comprobaron duplicados,
collation simple/case-sensitive, JSON Schema de servidor, ausencias/null/tipos y comportamiento
multikey. Índice único no sustituye schema ni prueba identidad de hardware. No se midió explain/costo.

## 4. Resultado de los quince casos existentes

Cada fila aprobó en **ambas** topologías;30 ejecuciones reales en total, separadas de las pruebas offline.

| Caso | Resultado demostrado |
| --- | --- |
| R01 | Índices creados explícitamente y consultados; unicidad y collation verificadas |
| R02 | Altas con writer existente, duplicados seguros y separación de claves por mayúsculas |
| R03 | Servidor rechaza subject ausente/null/array/número con código121 |
| R04 | Dos procesos, conexiones propias y barrera ready: un ganador CAS y un CONFLICT |
| R05 | A→B→A incrementa versiones; versión antigua y sesión previa rechazadas |
| R06 | Dos procesos consumen un challenge: un ganador; replay/duplicado y consumedAt array[null] rechazados |
| R07 | Expiración lógica del challenge con documento todavía presente; no depender de TTL |
| R08 | Sesión por hash, token ausente del documento, digest único, touch, logout/revoke idempotente y rechazo posterior |
| R09 | Idle/absoluto rechazados con reloj inyectado y documento presente; no borrado TTL exacto |
| R10 | Baja/reactivación de usuario/cliente no revive sesiones; generación y realm aislados |
| R11 | Revocación persistida por un proceso y autenticación rechazada por otro después del ACK; checkpoint/retry tras fallos inyectados, recibos inválidos y respuesta CAS perdida simulada |
| R12 | Consultas Mongo con jerarquía y ventanas propias para A/B; frontera300/500, timestamps/clientes de payload no autorizan; otro dispositivo/arrays/fuera de ventana excluidos, sin asociación vacío y source no verificado denegado |
| R13 | $literal conserva operador como dato y demuestra campo comercial libre no confiable;17MiB rechazados sin insertar |
| R14 | Índice compuesto: ausente/null colisionan, número/string distintos y array multikey duplicado rechazado |
| R15 | Cierre explícito de cliente: repository rechaza uso posterior sin reconexión implícita |

La procedencia positiva de R12 es **sintética**. _receivedAt no se usó como prueba única de
pertenencia; cuando falta atribución verificada, el planner rechaza la consulta. Esto no autentica IoT.

## 5. Evidencia multiproceso

Se amplió el caso R11 y los workers existentes para cubrir el pedido de revocación entre procesos,
sin crear otra suite. El token sintético viajó solo por IPC, nunca por logs ni argumentos CLI.

| Operación | PIDs standalone | PIDs replica set | Evidencia |
| --- | --- | --- | --- |
| CAS R04 |14108 /41664 |38956 /45908 | Un ganador por carrera, expectedVersion compartida |
| Challenge R06 |17520 /8308 |42796 /29124 | Un consume; replay=false |
| Revocación R11 |36396 /26636 |16672 /25532 | Primer proceso confirma persistencia; segundo rechaza autenticación después de ACK |

Son procesos OS distintos con conexiones reales, no dos Maps simuladas ni solo dos conexiones
del mismo proceso. El orden de revocación usa mensajes/ACK, no sleeps como prueba de causalidad.
No se promete cubrir todos los interleavings ni cancelación de requests ya admitidos.

## 6. Fallos reales, reproducción y correcciones locales

Hubo **nueve intentos fallidos de preparación** antes de la corrida standalone final. No se
ocultaron ni contabilizaron como casos R aprobados. Ninguno llegó a fallar un caso R: fallaron
arranque/guardias/conexión/aprovisionamiento antes de ellos. El replica set aprobó en su primer intento.

| Evidencia | Causa y corrección |
| --- | --- |
| Standalone1–2 | MongoDB no-root: Permission denied en /data/db/journal. Se hizo explícito mode1777 en ambos tmpfs propios. PowerShell Stop abortaba readiness ante stderr nativo; se acota Continue a las comprobaciones y se conserva el exit code |
| Standalone3 | Guard esperaba tmpfs en Mounts, pero Docker --tmpfs informa HostConfig.Tmpfs y Mounts vacío. Regresión D10 falló antes; se soporta configuración válida y se exige comprobar /proc/mounts |
| Standalone4–6 | MongoDB vivo, HostConfig.PortBindings solicitado pero NetworkSettings.Ports sin mapping; host ECONNREFUSED sobre red internal. Se reemplazó por bridge exclusivo NAT, loopback y sin masquerade. D11 reprodujo que la guardia no exigía mapping efectivo; ahora lo exige |
| Standalone7 | Prefijo db02_auth rechazado por validador existente agro_auth_*. Se corrigieron fixtures/consultas/cleanup a agro_auth_db02; **no** se relajó configuración productiva. D12 falló antes y aprueba después |
| Standalone8–9 | createIndex devuelve14031 OutOfDiskSpace en tmpfs512MiB. Se aumentó a1024MiB y RAM1536MiB; no se deshabilitó el umbral de disco de MongoDB |

Se agregaron diagnósticos de fase/código/clase sanitizados y captura de inspect/logs del contenedor
propio antes de retirarlo. No se vuelcan URIs, credenciales, tokens o mensajes originales de puertos.
Los originales de los archivos editados se preservaron en evidencia local. Sin cambios en src,
modelos, validadores, contratos HTTP, dependencias, frontend o iot-ingest. No se alteraron expectativas
para convertir fallos en éxitos: se conservaron las guardias previas y añadieron tres regresiones.

## 7. Regresión del backend y Git

| Validación real | Resultado |
| --- | --- |
| npm ci | Exit0,120 paquetes; warning transitivo node-domexception existente; lock/package sin cambios |
| npm run typecheck / npm run build | Exit0 |
| npm test | **360/360**,357 anteriores +D10/D11/D12;0 fallos/skips/canceladas |
| Regresión HTTP frente a c8aed231 | **13/13 equivalentes**,0 cambios intencionales/regresiones |
| git diff --check / sintaxis PowerShell / referencias | Aprobados |
| /health y startup | Público200/{status:ok}; autenticación y telemetría productivas sin activar |

Dev/HEAD/origin-dev siguen c8aed231; main intacta. Nueve archivos modificados del harness/guía/tests
y este informe nuevo sin seguimiento; sin staging, commit, push, PR, cambio de rama ni deployment.
No se modificaron datos ni servicios ajenos. Los informes anteriores conservan su evidencia histórica
de pruebas pendientes; este informe registra el resultado real posterior.

## 8. Evidencia y limpieza final

Evidencia local fuera del árbol publicado del worktree:
`../integraciones/agro-db02-docker-real-20261119/`.
Incluye estado-inicial.json (153 hashes), originales/, standalone-attempt-1…10.log,
replica-set-attempt-1.log, regresiones antes de corregir, npm-ci.log, npm-test.log,
http-regression.json, resultados-reales.json e inventario docker-final.json.
Se copiaron manifests resources-*, inspect-*, server-*.log y results-*.jsonl del launcher existente.
resultados-reales.json conserva inventario completo de índices, PIDs y resultados de cada corrida.

Se crearon y retiraron **11 contenedores y11 redes exclusivos**, incluyendo intentos fallidos.
Todos los manifests indican cleanupConfirmed=true; las dos corridas finales confirman eliminación
de sus siete colecciones y ausencia posterior de colecciones. Luego se retiró el contenedor/red
por ID/label, sin dropDatabase, prune ni borrados globales. Estado final:0 contenedores,0 redes
de la campaña,0 volúmenes y ningún listener27029; redes iniciales bridge/host/none preservadas.
Docker Desktop continúa encendido y la imagen oficial permanece en caché, sin servicios MongoDB
de esta tarea activos. No se eliminaron imágenes compartidas ni recursos ajenos.

## 9. Límites y requisitos para Preview/integración real

- Standalone y replica set **de un nodo** no certifican tolerancia a fallos de clúster multinodo.
  No se probó restart/journal duradero: tmpfs desaparece al retirar el recurso.
- CAS/challenge/revocación se probaron entre procesos del mismo host contra un servidor local.
  No es una prueba de distribución geográfica, partición de red ni consistencia durante failover.
- R11 mezcla persistencia real con fallos de port/ACK **inyectados**. No equivale a pérdida de ACK
  real en la red. R15 es cierre de cliente, no caída del servidor. TTL físico/latencia de borrado no medidos.
- Falta writer aprobado para cierre/apertura atómica de asociaciones; no usar un plan como permiso
  durable. Revalidar antes de ejecutar y aplicar presupuesto/paginación global en futuros adapters.
- IoT mantiene pendientes webhook autenticado, identidad técnica, aliases/deduplicación, índice
  fail-closed y logging/debug seguro. Atrasos tras reasignación necesitan epoch/handoff verificable;
  flags sintéticos de esta campaña no habilitan telemetría comercial.
- Preview requiere inventario físico BSON/IDs/índices/permisos y mapping BE-02 aprobados,
  contratos FE/GIS/errores/unidades, operación/limiter/observabilidad y autorización de activación.
  No acceder a Atlas ni habilitar login por el solo hecho de aprobar estos fixtures locales.

Próximo paso: revisar las correcciones demostradas y publicar/integrar **en otra tarea autorizada**;
después coordinar la campaña de fallos/durabilidad y las dependencias reales. No se inicia BE-10.
