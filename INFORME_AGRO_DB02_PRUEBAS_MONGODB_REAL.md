# AGRO-DB-02 — Validación local de persistencia: informe

19/11/2026. Backend Proyecto-Agro-Org/be-agro, worktree `.local-consolidacion/dev`.
**Resultado: harness implementado y validaciones offline aprobadas; MongoDB real bloqueado
por ausencia de un motor local aislado verificable. No se certifica persistencia real.**

## 1. Estado inicial, fuentes y preservación

HEAD, origin/dev y lectura remota GitHub dev: `ec56d26510ef9cd2a9620c148a9ec062d13727ed`.
Main/origin-main: `1bb20f76b7a739f42c75b37b9a64315276560ec1`. Sin cambios de ramas/referencias.
Inicialmente once archivos AGRO-DB-01 sin seguimiento y cero modificaciones versionadas.

Se leyeron los cinco documentos DB01, sondas e informes BE-09.3/09.3A/09.5/09.5A, plan,
especificación, DoD, contratos/modelos/repositories, writer/CAS y sesión. Se reutilizan esas
implementaciones: no segundo catálogo, modelos agronómicos definitivos ni endpoints nuevos.

Antes de implementar: hashes de141 archivos (130 versionados +11 DB01) y copias de los once
sin seguimiento en `../integraciones/agro-db02-20261119/agro-db01-original/`.
Se conservan worktrees históricos, informe privado BE-05 y respaldos previos; no reset/clean.

## 2. Entorno efectivamente observado

| Elemento | Resultado real |
| --- | --- |
| Sistema | Windows/PowerShell, runtime Node24 y TypeScript5.9.3 del proyecto |
| Docker/Podman | No encontrados por Get-Command ni ubicaciones/servicios/registro inspeccionados |
| mongod/mongosh | No encontrados por esos mecanismos; drivers npm existentes no son un servidor |
| WSL | wsl.exe presente; --list --quiet respondió que el sistema no tiene acceso al archivo; no se verificó una distro utilizable |
| Intento de launcher autorizado | Rechazó Docker unavailable antes de crear recursos |
| MongoDB versión / topología | No obtenidas; ninguna instancia iniciada ni conexión positiva |
| Imagen propuesta | mongodb/mongodb-community-server:8.0-ubi8; no descargada, tag/versión efectiva no comprobados |
| Recursos creados | Solo archivos/hashes/logs y artefactos locales de build/dependencias; cero contenedores, redes, volúmenes, DB o colecciones |
| Recursos MongoDB activos de esta tarea | Ninguno; no se afirma haber inventariado servicios ajenos de todo el equipo |

No se buscaron credenciales ni se usaron URIs existentes. No Atlas, MongoDB externo, FE, IoT,
Vercel, GIS o endpoints desplegados. No se instalaron servicios ni se modificó configuración global.

## 3. Implementación y seguridad de conexión

- [guard.ts](scripts/agro-db02/guard.ts): opt-in, runId/container exactos, puerto/topología;
  rechazo de URI/host/base externos; Docker por IPC local, inspect de imagen/label/red/bindings/mounts.
- [resources.ts](scripts/agro-db02/resources.ts): URI construida127.0.0.1, family4/directConnection,
  hello validado, límites de conexión, autoDDL/buffering/retries deshabilitados. DDL explícito solo
  en siete colecciones nuevas del namespace de ejecución, usando modelos/validadores existentes.
- [cases.ts](scripts/agro-db02/cases.ts): quince casos de integración preparados; modelo y
  repositories reales, fixtures sintéticos, sin Google real ni catálogo alternativo en runtime.
- [processes.ts](scripts/agro-db02/processes.ts) y [worker.ts](scripts/agro-db02/worker.ts): dos
  procesos con conexiones propias, handshake IPC y PIDs verificados; CAS y challenge con un ganador.
- [runner](scripts/audit-agro-db02-mongodb-local.ts): supervisor180s, eventos sanitizados,
  parada ante fallo y finally para limpieza verificada de objetos propios. Sin conexión al importar.
- [launcher PowerShell](scripts/agro-db02-local.ps1): contenedor/red interna exclusivos, loopback,
  tmpfs sin volúmenes ajenos, manifiesto y retiro de recursos propios. No cambia startup/scripts npm.
- [guardias offline](test/agro-db02-guard.test.js): ocho pruebas de seguridad, sin servidor.

Namespaces empresarial/IoT son prefijos separados en una DB descartable para fixtures. Eso no
demuestra permisos RBAC por servicio. No se crean colecciones productivas ni migraciones.
MONGODB_URI no se incorpora al destino; no DNS/SRV, credenciales, proxy ni discovery remotos.
La comprobación Docker no es meramente buscar la palabra localhost en una cadena.

## 4. Índices, CAS, sesión, challenges y temporalidad

**Índices realmente observados: ninguno**, porque no hubo servidor. El harness registra en R01
listIndexes, keys/options/collation de lo que cree: users realm/id y realm/issuer/subject únicos,
clients realm/id, session realm/digest, TTL auth, dispositivo sourceId/clientid y consultas temporales.
Challenge usa _id compuesto realm:digest; no se inventa una garantía de índice extra.

La [matriz de resultados](MATRIZ_AGRO_DB02_RESULTADOS.md) enumera R01–R15, todos sin ejecutar.
Incluye duplicados/null/ausencias/BSON/collation, CAS/versiones A→B→A, dos procesos, hash/touch/logout,
idle/absoluto independientes de TTL, revocación/rehabilitación, realm, checkpoint y consultas temporales.
No se reemplaza ningún test existente para aprobar; el total previo se conserva.

R11 combina almacenamiento real futuro con fallos **inyectados** de invalidator/recibo/retorno
void y pérdida simulada de respuesta después del CAS. Releerá el catálogo y recuperará el checkpoint;
no equivale a una pérdida real de paquetes/ACK. R15 cerrará el cliente, no producirá un failover.

R12 conecta el planner DB01 a ports de fixture que filtran en MongoDB por realm/cliente/jerarquía
y ventana. Usa clientes A/B, sensores lógicos y dispositivos técnicos distintos de IDs comerciales.
El mismo dispositivo reasignado no concede intervalos históricos ajenos; timestamp del emisor y
cliente_id manipulados no gobiernan la consulta. Fuente no verificada se rechaza antes de leer raw.
Las marcas positivas de confianza son únicamente fixtures: no aprueban la ingesta actual.

R13 reproduce el patrón literal/upsert en colecciones propias: conserva operadores como datos,
demuestra riesgo de campos comerciales libres y rechaza17MiB sin insertar. No prueba el límite
HTTP1MiB de IoT ni autentica el webhook. IOT-01/02/03/05/06 y atribución tardía siguen abiertos.

## 5. Validaciones ejecutadas y correcciones

| Validación | Resultado |
| --- | --- |
| npm ci | Exit0,120 paquetes; package/lock conservados; sin dependencias agregadas |
| npm run typecheck | Exit0 |
| npm run build | Exit0 |
| npm test | **356/356**:348 anteriores +8 guardias; sin fallos/skips/canceladas |
| HTTP diferencial contra ec56d265 | **13/13**, sin cambio público ni regresión |
| Sintaxis PowerShell | Aprobada por parser local |
| Launcher con autorización | Bloqueo seguro Docker unavailable, sin recursos |
| MongoDB real / replica set / multiproceso real | **0 ejecutados**; no confundir guardias con persistencia |
| Whitespace / referencias / preservación | Comprobados al cierre, sin secretos detectados en cambios revisados |

Durante preparación se corrigieron errores de tipado del harness: realm tipado y opciones de
command compatibles con el driver (timeoutMS). Se reforzó el chequeo del flag replSet, correlación
del PID de workers, cierre y registro de ownership antes del arranque. Se ordenaron fixtures para
revincular el usuario después de cambiar la generación del cliente. No son defectos reproducidos
contra MongoDB; no hubo correcciones al backend productivo ni cambios de contratos para aprobar.

Defecto offline reproducido DB02-G06: la primera guardia rechazaba mounts ajenos, pero aceptaba
una lista vacía, sin demostrar los dos tmpfs prometidos. La regresión falló con Missing expected
exception; se exige ahora exactamente /data/db y /data/configdb como tmpfs distintos. Se conserva
la expectativa y se reejecuta toda la suite. Es una corrección del harness nuevo, no de MongoDB.

Evidencia local: `../integraciones/agro-db02-20261119/estado-inicial.json`, copias DB01,
npm-ci.log, npm-test.log, environment-blocker.log y http-regression.json. Los futuros manifiestos
resources-*.json/results-*.jsonl solo existirán cuando pueda crearse un entorno nuevo autorizado.

## 6. Limitaciones y recomendación

El harness está compilado y sus fronteras offline comprobadas; su rama positiva MongoDB/Docker
no está validada en este equipo. La topología solicitada por defecto es un replica set local de
un nodo; no se presentó como topología usada ni como prueba de tolerancia a fallos multinodo.
No se midió TTL físico, journal tras restart, particiones, failover, durabilidad distribuida,
writer atómico de asociaciones ni integración externa. tmpfs no sirve para certificar persistencia
tras retirar recursos. No hay hallazgo de persistencia aprobado o corregido sin esa evidencia.

Próximo paso: Operación/QA habilita Docker Linux local aprobado; ejecutar primero standalone y
luego replica set usando [guía](GUIA_AGRO_DB02_ENTORNO_LOCAL.md), revisar todos los resultados,
PIDs, índices y limpieza. Corregir cualquier fallo real antes de aceptar persistencia.
Después diseñar campaña persistente/fallos separada y coordinar con Datos/IoT identidad autenticada,
handoff/epoch, BSON/índices, permisos/mapping. BE-02, unidades BE-04, FE/GIS y Preview siguen pendientes.
No habilitar telemetría comercial ni login productivo ni iniciar BE-10.

## 7. Estado final de Git

Dev y main conservan SHA inicial; sin staging, commit, push, PR, merge ni ramas nuevas.
Los141 archivos iniciales y copias DB01 se preservan byte a byte. Once archivos nuevos DB02:
seis TypeScript del harness, launcher PowerShell, test de guardias y tres documentos.
Total22 archivos sin seguimiento incluyendo DB01. dist/node_modules permanecen excluidos;
ningún .env/backup/archivo privado se incorpora. FE/IoT y respaldos no se modificaron.
