# BE-09.3A — Auditoría final local de persistencia y catálogo

19/11/2026. Repositorio Proyecto-Agro-Org/be-agro. Worktree
`C:\Users\CamilaGonzález\be-agro\.local-consolidacion\dev`, rama `dev`.
HEAD y origin/dev: `3ac72ab763b58e1795bd53b8c2bd2d5f481251e0`.

## 1. Resumen y recomendación

Auditoría local completada: **266/266 pruebas**, 252 anteriores conservadas y
14 nuevas. Typecheck/build/instalación reproducible correctos, **13/13 escenarios
HTTP equivalentes**. Se reprodujeron y corrigieron dos hallazgos: uno medio de
integridad de filtros y otro bajo de comprobación de acknowledgements.
No se identifican hallazgos altos/críticos locales abiertos en el alcance revisado.

Apta para revisión y posterior publicación/integración **como infraestructura
inactiva**, manteniendo los gates externos. No apta para habilitar autenticación
real ni cerrar BE-09. No se hizo commit, push, PR, merge, deploy o cambio de rama.
No se accedió a Atlas, cuentas Google reales, frontend, IoT ni datos existentes.

## 2. Alcance y preservación

Se inspeccionaron los seis módulos BE-09.3, suite nueva y documentación; también
SessionService/puertos BE-09.2, contexto/autorización BE-09.1, errores/logging BE-08,
manager/config MongoDB, app/listener, configuración de entorno, dependencias y
contratos/pendientes BE-02/03. No existe servicio de challenges duplicado: se usa el
método existente del servicio de sesiones. Los controllers no consultan MongoDB.

Estado inicial: diez archivos de trabajo BE-09.3, sin stage; origen universitario
y base esperada. Se guardaron tamaños/hashes y texto original de la suite antes
de editar. Los informes BE-09.3 reciben anexos, preservando su contenido anterior.
Documentación BE-09.0…2, pruebas versionadas, dependencias, main y worktree histórico
sin cambios; respaldos e informe local BE-05 verificados por hash.

Las 32 definiciones originales de tests BE-09.3 se comparan por AST y conservan
íntegras sus expectativas/cuerpos. Solo se amplió el simulador para representar
la coincidencia de elementos de arrays en igualdad/comparación MongoDB y `$literal`.
Los diez archivos de tests de HEAD siguen idénticos. No se rebajó un contrato
para hacer aprobar una prueba.

## 3. Hallazgos reproducidos

| ID | Severidad | Defecto y efecto | Corrección y evidencia |
|---|---|---|---|
| F09.3A-01 | Media — integridad sobre BSON malformado | Igualdad/comparaciones de query pueden coincidir con elementos de arrays. Realm array podía permitir revocar una fila de otro realm; digest/nonce arrays podían satisfacer claim; createdAt/id inválidos podían actualizarse antes de fallar al mapear retorno | Guardias `$expr` de tipo del campo completo, igualdad escalar con `$literal` para realm/digest/nonce/id y fechas BSON Date para actividad/expiry. A01/A02/A03 fallaron antes y aprobaron después |
| F09.3A-02 | Baja — confirmación de escritura | Insert aceptaba cualquier valor truthy de acknowledged, por ejemplo el string "false", como confirmación | Exigir `acknowledged === true` y conservar comprobación exacta de insertedId. A04 falló por ausencia de rechazo antes y aprueba después |

F09.3A-01 no es un incidente observado ni un bypass HTTP demostrado: BE-09.2 ya
validaba los records leídos antes de autenticar. La corrección evita mutaciones
incorrectas del repositorio ante esas variantes de datos malformados. No se afirma
que el simulador constituya una ejecución MongoDB real. La semántica de arrays está
fundamentada en la documentación oficial y ejercitada sobre comandos Mongoose reales.

F09.3A-02 defiende contra resultados de driver/adaptador incoherentes; no afirma
que un MongoDB correcto emita acknowledged como string. Los fallos se sanitizan.

La regresión anterior F09.3-01 de arrays que contienen null se conserva: P18 y A05
confirman que null escalar difiere de missing, array vacío, array con null/dobles
null y estado ya usado. No se permite reutilizar un challenge consumido ni borrar
una revocación mediante actividad.

## 4. Operaciones y atomicidad

| Operación | Dependencia técnica auditada | Estado real de evidencia |
|---|---|---|
| Crear sesión/challenge | Validación lógica/Mongoose; insert con ACK e ID exactos; unicidad por `_id`/realm-digest | Código/modelos/driver simulado probados; servidor pendiente |
| Consumo único | updateOne sobre un documento, filtro de realm/digest/nonce exactos y escalares, estado null y expiry | Dos Connections independientes sobre simulador: un ganador; atomicidad entre procesos reales pendiente |
| Actividad | findOneAndUpdate, estado aún activo, fechas correctas, `$max`, returnDocument after | P10/P12/A09 prueban orden inverso y carrera con revocación en simulación |
| Revocación | updateOne realm/digest exactos, estado null escalar y primera fecha | Idempotencia/nueva admisión probadas con puertos compartidos; durabilidad real pendiente |
| Consulta por hash/ID | Alcance exacto de namespace/realm y clave; output validado, proyección cerrada | No consulta pública sin alcance; no se devuelve documento Mongoose a HTTP |
| Catálogo | Lectura usuario/membership y cliente por separado; versionado esperado del writer futuro | No transacción entre stores, writer físico pendiente BE-02 |

Los updates no dependen de un lock local ni guardan un snapshot completo que
pueda borrar revokedAt. No hay upserts ni transacciones implementadas. La
atomicidad de documento único y los índices únicos son requisitos del servidor,
no garantías certificadas por Maps, TypeScript, Zod o runValidators.

Los filtros nuevos validan los campos que seleccionan la fila y su estado temporal;
no sustituyen una validación BSON completa de la colección. Los mappers rechazan
otras inconsistencias en lecturas/retornos. Los validators físicos y su modo de
aplicación deben aprobarse/probarse antes de activar la persistencia real.

## 5. Índices, expiración y revocación

Se conserva readiness de `_id` y único `{realm:1,digest:1}` completo, no parcial,
sparse, hidden ni con collation diferente de simple. No se crearon índices reales.
TTL Date sobre expiresAt/absoluteExpiresAt sigue siendo propuesta de limpieza,
no una condición de autorización. P03/P05 cubren falta de unicidad y duplicados
simulados; P19 cubre fallo de lectura de índices sin repositorio parcialmente listo.

A06 mantiene una fila expirada presente y comprueba rechazo de su token, sin
esperar limpieza física. Fechas ausentes, arrays, números, null o strings no
permiten actualizar actividad en los casos comprobados. `$$NOW` es el snapshot
temporal del comando: no asegura que una operación termine antes de la expiración
tras toda espera de red/lock. Se conservan rechecks y leases de BE-09.2.

Revocación impide nuevas admisiones y updates idle sobre la fila revocada. No
cancela operaciones ya admitidas. Majority/journal/readConcern y tiempos del
servidor están solicitados por el código; no se probaron replicación, rollback,
failover, limpieza TTL, retryable writes ni pérdida real de confirmación.

La preparación de índices es inicial, no vigilancia de DDL. Dropear/recrear una
colección después de readiness puede invalidar sus garantías o permitir creación
implícita por un insert según permisos. Namespace/topología/sharding y ciclo de
vida de índices requieren control operativo, como ya documentó BE-09.3.

## 6. Catálogo usuario-cliente y límites observados

Se mantiene un usuario → un cliente; no se inventaron roles ni múltiples clientes.
Arrays de pertenencias/identidades, estados inexistentes, usuario/cliente distinto
del consultado y datos incoherentes se rechazan. Usuario desconocido/sin cliente/
deshabilitado o cliente deshabilitado no reciben un tenant default. Email no
identifica ni enlaza usuarios. Queries y proyecciones de salida son cerradas.

**Duplicados físicos:** A08 prueba rechazo de arrays ambiguos y del error explícito
de un store. El reader no puede descubrir registros ocultos si su store devuelve
silenciosamente el primero. Se aclaró el contrato: el store real debe imponer
unicidad por principal/ID/realm o rechazar ambigüedad. No se implementó ni certificó
la consulta física del catálogo ni se marcaron esos duplicados como resueltos.

Pertenencia/clientId/securityVersion se revalidan en nuevas admisiones. El writer
futuro debe versionar correctamente reasignación, deshabilitación/reactivación y
cambios de identidad para invalidación permanente. Flags sin versionado no ofrecen
esa garantía. BE-02 debe aprobar la estructura física y ese protocolo de escritura.

**Límite de consistencia entre stores:** A10 reproduce que deshabilitar al usuario
mientras espera un touch puede dejar que la escritura de actividad termine, aunque
la autorización final sea rechazada. Por ello, «ninguna escritura después de toda
invalidación del catálogo» **no está garantizado**. Para resolverlo se necesita
coordinación/versionado/revocación en el writer o una estrategia transaccional
aprobada con el catálogo real. No se ocultó esa limitación agregando relecturas que
tampoco cerrarían la carrera. La protección de autorización continúa activa y no
se entrega un contexto válido en ese caso.

## 7. Seguridad, configuración y arquitectura

Se revisó inyección de operadores y literalización: A07 impide objetos/epochs
inválidos antes de IO; A12 trata un ID lógico que empieza con `$` como dato, no
expresión. No se persisten tokens raw, nonce raw ni credenciales Google; solo hashes
y metadatos. A11, K07 e I05 cubren strings/objetos/causas/proxies y errores de driver
sin exponer URI, Authorization, perfil ajeno o stack al sink BE-08.

La consulta inicial de autenticación se acota por principal/ID/hash y realm; aún
no hay cliente autenticado. Las consultas de negocio deben seguir usando el
repositorio scoped por clientId y su jerarquía. No se agregaron endpoints BE-10.

No cambiaron configuración de entorno, manager MongoDB, Google, app, listener,
HTTP legacy ni Vercel. No se conecta al importar. El repositorio exige conexión
ya abierta y configuración explícita; no hay fallback de memoria productivo.
MaxTimeMS/wtimeout no son un deadline completo de login. El cierre/fallo de conexión
y su recuperación controlada conservan las pruebas previas BE-07/09.3.

Se revisaron 43 archivos TypeScript de src/scripts: sin any ni ciclos estáticos;
app.ts no alcanza modelos/repositorio auth, router ni script de prueba manual.
La caché por Connection solo contiene metadatos de modelos. No se agregó una
infraestructura de identidad paralela ni un selector de verificadores falsos.

## 8. MongoDB real: bloqueo y procedimiento reproducible

La inspección local no encontró mongod, mongosh, mongo o docker en PATH, servicio
MongoDB ni configuración de testing dedicada en el repositorio. Esto no demuestra
inexistencia absoluta de algún servidor; **no se identificó una instancia autorizada
y aislada**. No se conectó a puertos/DB desconocidos, no se descargó ningún binario,
no se instaló servicio y no se solicitaron credenciales.

Versión MongoDB real: **no obtenida**. Ninguna prueba real se presenta como aprobada.
Quedan pendientes comandos efectivos, unique indexes, dos procesos reales,
concurrencia de servidor, majority/journal, red/failover y TTL físico.

Se preparó `scripts/audit-auth-mongodb-local.ts`, compilado pero **no ejecutado con
opt-in**. Solo se ejecutó su rechazo sin autorización, antes de conectar (A14).
El comando futuro requiere que el responsable ya haya confirmado una instancia
exclusiva, sin datos ajenos y sin túneles hacia Atlas/otros proyectos. Loopback
por sí solo no demuestra aislamiento.

Solo entonces, con el MongoDB local existente y autorizado, ejecutar manualmente:

```powershell
npm run build
$env:AGRO_AUTH_LOCAL_AUDIT = 'AUTHORIZED_DISPOSABLE_LOOPBACK_ONLY'
$env:AGRO_AUTH_LOCAL_PORT = '27019' # Puerto real de la instancia exclusiva aprobada.
# Opcional: AGRO_AUTH_LOCAL_REPLICA_SET, solo con el nombre local aprobado.
try {
    node dist/scripts/audit-auth-mongodb-local.js
} finally {
    Remove-Item Env:AGRO_AUTH_LOCAL_AUDIT -ErrorAction SilentlyContinue
    Remove-Item Env:AGRO_AUTH_LOCAL_PORT -ErrorAction SilentlyContinue
    Remove-Item Env:AGRO_AUTH_LOCAL_REPLICA_SET -ErrorAction SilentlyContinue
}
```

El script ignora MONGODB_URI y no permite elegir URI, host remoto, credenciales o
base existente. Usa 127.0.0.1, directConnection=true y un nombre aleatorio nuevo
`agro_auth_audit_<24 hex>`, anunciado antes de conectar. Rechaza un namespace con
colecciones preexistentes. Solo en esa base crea dos colecciones de fixtures e
índices propuestos; prueba el error 11000 del índice, consumo con dos conexiones,
replay, revocación visible y null escalar. Obtiene buildInfo para registrar versión.
No es una certificación de durabilidad distribuida ni prueba de dos procesos OS.

Finally elimina únicamente las colecciones que el script consiguió crear, tras
comprobar DB/prefijos exactos; nunca usa dropDatabase ni borra otra base. Una
limpieza fallida no se declara exitosa. Si el proceso es terminado forzosamente,
inspeccionar la base aleatoria anunciada y limpiar solo sus colecciones creadas
`agro_auth_manual_challenges`/`agro_auth_manual_sessions` tras confirmar propiedad.
No ejecutar esos pasos en Atlas o una base de otro proyecto.

## 9. Validaciones reales y pruebas nuevas

| Verificación | Resultado |
|---|---|
| Inicial npm ci/typecheck/build/npm test | Exit 0; 252/252 antes de corregir |
| Reproducción A01…A04 | Cuatro fallos antes de arreglar; cuatro aprobados después |
| Suite de persistencia | 46/46: 32 anteriores + 14 A |
| Ronda final npm ci | Exit 0, lock intacto, sin servicios/binarios MongoDB nuevos |
| npm run typecheck | Exit 0, strict NodeNext |
| npm run build | Exit 0, incluido script manual |
| npm test | **266/266**, 0 fallos/skips/canceladas |
| git diff --check / whitespace de nuevos | Sin errores |
| Comparación HTTP contra 3ac72ab | **13/13 equivalentes**, 0 cambios inesperados |
| AST de tests anteriores | Diez archivos de HEAD intactos; 32 cuerpos/expectativas de BE-09.3 idénticos |
| Dependencias | package/lock sin cambios; npm ls coherente, Mongoose 9.12.2 y TypeScript 5.9.3 |

Se conserva warning transitivo node-domexception 1.0.0 de npm ci; no se actualizaron
versiones ajenas. Sin dependencias nuevas. Compilación/tests no certifican ausencia
de vulnerabilidades. No se modificó el comportamiento HTTP productivo.

La regresión compara status/cuerpo/headers de health GET/HEAD, CORS permitido,
denegado, slash, subdominio, wildcard, listas vacías con/sin Origin, OPTIONS, 404 y
500, con módulos de la base transpileados en memoria frente a dist actual.

Pruebas A01…A14 y riesgos se detallan en la
[matriz de trazabilidad](MATRIZ_BE09_3A_TRAZABILIDAD.md).

## 10. Archivos, Git y gates finales

Respecto del estado inicial BE-09.3, se modificaron: repositorio Mongoose,
comentario de contrato IdentityCatalogueStore, suite de persistencia, README y los
dos documentos BE-09.3 mediante anexos. Nuevos: script manual y los dos documentos
BE-09.3A. Config/modelos/mappers/reader del catálogo mantienen su implementación.
Los archivos previos sin seguimiento no se presentan como creados por esta auditoría.

Git sigue en dev/3ac72ab, índice vacío. Main/origin-main conservan
`1bb20f76b7a739f42c75b37b9a64315276560ec1`; informes originales, worktree histórico y
respaldos preservados. No commit/push/PR/merge/deploy ni BE-10.

Antes de habilitar: aprobar catálogo/schema/IDs/namespace BE-02 y unicidad física;
definir writer/versionado/consistencia entre catálogo y sesiones; probar MongoDB
aislado real; aprobar contratos FE/BE-03 y GIS; resolver FE/XSS, limiter distribuido,
deadlines/cancelación y observabilidad; validar Preview autorizado. Permanecen
abiertos, sin aprobación implícita por esta auditoría.

## Fuentes técnicas

[MongoDB: consulta de arrays](https://www.mongodb.com/docs/manual/tutorial/query-arrays/),
[type expresión](https://www.mongodb.com/docs/manual/reference/operator/aggregation/type/),
[literal](https://www.mongodb.com/docs/manual/reference/operator/aggregation/literal/),
[atomicidad](https://www.mongodb.com/docs/manual/core/write-operations-atomicity/),
[Mongoose findOneAndUpdate](https://mongoosejs.com/docs/tutorials/findoneandupdate.html).
La documentación explica las reglas empleadas; no reemplaza una ejecución MongoDB real.
