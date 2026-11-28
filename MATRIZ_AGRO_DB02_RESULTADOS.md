# AGRO-DB-02 — Resultados y cobertura real

19/11/2026. Base `ec56d26510ef9cd2a9620c148a9ec062d13727ed`, rama dev.
**MongoDB real: 0 casos ejecutados.** No se encontró un motor local aislado verificable.
Los casos R son código preparado, no resultados positivos ni pruebas sumadas al total offline.

## Validaciones efectivamente ejecutadas

| Control | Resultado / clasificación |
| --- | --- |
| HEAD, origin/dev y lectura GitHub dev | Coinciden con ec56d265; main conserva1bb20f76 |
| Preservación inicial | 141 archivos: 130 versionados y once AGRO-DB-01; hashes y copia de los once nuevos |
| Inventario de herramientas | Docker/Podman/mongod/mongosh no encontrados en PATH, ubicaciones habituales/servicios/registro consultados sin instalación encontrada; WSL no permitió inventario |
| Launcher con -AuthorizeDisposable | Rechazo: Docker unavailable. No server installation attempted. Antes de crear red/contenedor/DB |
| npm ci | Exit0, 120 paquetes, sin cambio de package/lock; warning transitivo node-domexception existente |
| npm run typecheck / build | Aprobados; strict/NodeNext; sin dependencias nuevas |
| npm test | **356/356**, 348 anteriores +8 guardias offline; cero fallos/skips/canceladas |
| Regresión HTTP contra ec56d265 | **13/13 equivalentes**, cero cambios nuevos intencionales/regresiones |
| Parser PowerShell | Sin errores sintácticos; ejecución positiva Docker no validada |
| git diff --check y archivos nuevos | Sin errores; referencias locales verificadas |

## Guardias offline nuevas

| Test | Evidencia offline, sin Docker ni MongoDB |
| --- | --- |
| DB02-G01 | Opt-in explícito, runId, ID de contenedor, puerto y topología obligatorios |
| DB02-G02 | Rechazo de URI/host/base aportados; MONGODB_URI preexistente no usada; URI local construida |
| DB02-G03 | Solo namespace exacto agro_db02_test_ + runId; no admin/ingesta ni otra ejecución |
| DB02-G04 | Docker por IPC local; TCP/SSH/DNS, incluso TCP loopback, rechazados |
| DB02-G05 | Fixture de inspect: ID/label/imagen/running/red exclusiva; rechazo de recurso ajeno |
| DB02-G06 | Fixture de inspect: solo127.0.0.1/puerto esperado; sin privilegios, bind mounts o volúmenes |
| DB02-G07 | Fixture de inspect: topología y replica set exactos; no flags omitidos/ajenos |
| DB02-G08 | CLI sin permiso rechaza antes de Docker/sockets; error constante sin URI/secretos |

Los fixtures de inspect no prueban que Docker real aplique esa configuración. La suite positiva
vuelve a consultar el contexto/inspect/red efectivos antes de conectar y antes de limpiar.

## Suite opt-in preparada: todos pendientes de MongoDB real

Implementación en [cases.ts](scripts/agro-db02/cases.ts). Los casos son secuenciales y se detienen
en el primer fallo; los siguientes no se consideran ejecutados. Cada resultado positivo futuro
debe incluir versión, topología, recursos, índices, limpieza y evidencia JSONL de esa ejecución.

| Caso | Operación preparada / aserción | Estado real |
| --- | --- | --- |
| R01 | Crear explícitamente índices declarados y consultar listIndexes de siete colecciones; unicidad/collation simple | No ejecutado |
| R02 | Altas desde writer existente, identidad/id duplicados, clientes duplicados y claves que difieren por mayúsculas | No ejecutado |
| R03 | JSON Schema servidor rechaza subject ausente/null/array/número con121 | No ejecutado |
| R04 | Dos procesos OS, conexión propia y barrera IPC; misma versión CAS, un ganador y un CONFLICT | No ejecutado |
| R05 | A→B→A, incremento/versiones, conflicto antiguo y rechazo de sesión previa | No ejecutado |
| R06 | Challenge compartido entre dos procesos, un consumo, replay/duplicado rechazados y array[null] no consumible | No ejecutado |
| R07 | Challenge vencido lógicamente pero físicamente presente: consume=false | No ejecutado |
| R08 | Sesión persistida por digest, token ausente del documento, touch, digest único, logout/revoke idempotente | No ejecutado |
| R09 | Idle y vencimiento absoluto con reloj inyectado, documento aún presente; no depender de TTL | No ejecutado |
| R10 | Baja/reactivación usuario y cliente, generación obsoleta, revinculación; lookup de otro realm vacío | No ejecutado |
| R11 | CAS real con fallo de invalidator inyectado, checkpoint/retry; respuesta CAS perdida simulada tras escribir, void de recibo y realm incorrecto | No ejecutado; caso mixto, no fallo real de red |
| R12 | Planner con ports Mongo locales: dos clientes, dispositivo técnico compartido por ventanas disjuntas, recepción300/500, out-of-window/otro dispositivo/arrays excluidos; cliente ajeno vacío; sin asociación vacío; procedencia no verificada rechazada | No ejecutado; confianza solo sintética |
| R13 | Pipeline con literal conserva operador como dato y demuestra campo comercial no confiable; documento17MiB rechazado sin fila | No ejecutado; no es el parser HTTP1MiB de IoT |
| R14 | Índice técnico compuesto: ausente/null colisionan, número/string distintos y array multikey duplicado rechazado | No ejecutado |
| R15 | Cerrar conexión explícitamente; repository existente rechaza uso posterior de forma segura | No ejecutado; no es partición de red |

R11 no convierte un recibo inventado en prueba de escritura: aplica primero la operación real
y degrada el contrato de respuesta a propósito, solo dentro del harness. Después relee persistencia
y recupera el checkpoint. Google es un verifier sintético aislado al script; no se llama GIS.

## Pruebas expresamente no demostradas

| Categoría | Estado / faltante |
| --- | --- |
| Standalone real | No ejecutado; launcher tiene opción separada |
| Replica set local de un nodo | No ejecutado; no equivale a tolerancia a fallos multinodo |
| Multiproceso CAS/challenge | Código preparado; cero ejecuciones reales |
| TTL físico | No se mide monitor/tiempo de borrado; expiración lógica es un control distinto |
| ACK/red/reintentos distribuidos | Inyección R11 y cierre R15 no prueban partición ni pérdida real de ACK |
| Durabilidad tras restart/journal/failover | Pendiente entorno persistente descartable y protocolo de fallos; tmpfs de esta suite no demuestra durabilidad |
| Escritura atómica de asociaciones | No hay writer definitivo aprobado; suite solo consulta fixtures |
| Identidad IoT real | No autenticada por el formato observado; source sintético positivo no habilita datos comerciales |
| Atlas / Preview / E2E FE-Google-IoT | Fuera de esta ejecución; sin accesos ni despliegues |

No se suman los15 casos preparados, los13 HTTP o las reproducciones IoT de DB01 al total356.
Ver [informe](INFORME_AGRO_DB02_PRUEBAS_MONGODB_REAL.md) y [guía](GUIA_AGRO_DB02_ENTORNO_LOCAL.md).
