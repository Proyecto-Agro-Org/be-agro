# BE-09.3 — Persistencia de autenticación y catálogo usuario-cliente

19/11/2026. Estado: implementación local independiente completada y auditada;
persistencia real y habilitación productiva pendientes. **BE-09 no Done**.
Worktree `.local-consolidacion/dev`, rama `dev`, base/HEAD/origin-dev después de
fetch: `3ac72ab763b58e1795bd53b8c2bd2d5f481251e0`.

## 1. Alcance y evidencia previa

Se revisaron el plan, especificación, DoD, propuestas BE-02/03, informes BE-09.0,
BE-09.1 y BE-09.2, configuración/manager MongoDB, adaptador Google, servicio de
sesiones y sus puertos, autorización, errores/logging BE-08 y pruebas existentes.
La base estaba limpia y corresponde al merge del PR #12. No había un Issue nuevo
con URL/número en esta consigna; se aplicó su alcance explícito. La suite inicial
aprobó 220/220; sus diez archivos de tests se preservaron sin editar.

No se consultó Atlas ni se usaron credenciales Google/MongoDB. Tampoco se hicieron
commit, push, PR, cambios de rama, despliegues, cambios Vercel, modificaciones FE,
IoT o datos existentes. `main` conserva `1bb20f76b7a739f42c75b37b9a64315276560ec1`.
Once originales/once copias y 21 respaldos históricos se verificaron por SHA256;
el informe local BE-05 permanece intacto y excluido. Documentación histórica
BE-09.0…2 y contratos BE-02/03 sin cambios.

## 2. Decisión de implementación y frontera de aprobación

Los records de challenge/sesión contienen metadatos técnicos suficientes para
preparar un adaptador Mongoose **opt-in**, sin decidir el modelo agronómico. Se
implementaron schemas, mappers y repositorio para esa propuesta; esto no aprueba
sus nombres físicos ni describe colecciones observadas en Atlas.

La factory exige una conexión Mongoose ya abierta explícitamente, un prefijo
aislado elegido por el llamador y los índices únicos necesarios ya existentes.
No selecciona URI, no conecta, no crea colecciones/índices, no migra y no se monta
en la aplicación default. En esta tarea solo se invocó con un driver simulado de
tests, sin socket ni MongoClient. No es persistencia productiva operativa.

El catálogo físico sí depende de BE-02: no se inventó `MongoIdentityCatalogueStore`
ni se registraron schemas de usuarios/clientes. Se implementó un adaptador de
lectura normalizado sobre un puerto obligatorio; su store persistente real queda
**bloqueado hasta aprobar nombres, BSON, relaciones y aprovisionamiento**.

## 3. Archivos y arquitectura

| Archivo nuevo | Responsabilidad |
|---|---|
| `src/config/authentication-persistence.ts` | Configuración explícita validada y congelada, sin fallback de colección |
| `src/models/authentication.models.ts` | Dos schemas técnicos propuestos, fechas BSON Date, auto-DDL/buffering desactivados |
| `src/repositories/authentication-record.mapper.ts` | Conversión explícita de records lógicos a BSON y retorno sin `_id` |
| `src/repositories/mongoose-session.repository.ts` | Implementa SessionRepository, readiness de índices y operaciones condicionales |
| `src/auth/identity-catalogue.contracts.ts` | Contratos lógicos de usuario, pertenencia, cliente y store de lectura |
| `src/repositories/identity-catalogue.repository.ts` | IdentityCatalogue con principal estable y cliente desde fuente confiable |
| `test/authentication-persistence.test.js` | 32 pruebas offline de modelos, repositorios, catálogo e integración |
| Este informe | Diseño, implementación, auditoría, evidencias y límites |
| `MATRIZ_BE09_3_PERSISTENCIA_SEGURIDAD.md` | Requisito/amenaza/control/prueba/estado/riesgo residual |

Único archivo previo modificado: README, con estado BE-09.3. No cambiaron
package.json/lock, env.example, dependencias, app/listener, Google, SessionService,
puertos BE-09.2, autorización BE-09.1, HTTP BE-08 ni infraestructura MongoDB previa.
No se duplicó challenge/service: se reutiliza `SessionService.challenge()`.

Flujo: código de composición futuro → conexión explícita autorizada → factory de
repositorio preparada → inyección en `createSessionService`, junto con el adaptador
de catálogo y el verificador existente. Route → Controller → Service → Repository
se conserva; los componentes nuevos no dependen de objetos Express.

## 4. Modelo técnico propuesto de autenticación

Dos colecciones **candidatas**, separadas de telemetría y catálogo agronómico:

| Colección derivada del prefijo explícito | Campos BSON propuestos |
|---|---|
| `<prefijo>_challenges` | `_id: string` = realm:digest; digest/nonceDigest SHA256 hex; realm/audience string; expiresAt Date; consumedAt Date o null escalar |
| `<prefijo>_sessions` | `_id: string` = realm:id; id/digest/realm/userId/clientId string; securityVersion Number entero seguro; createdAt/absoluteExpiresAt/idleExpiresAt Date; revokedAt Date o null escalar |

El prefijo debe cumplir `agro_auth_[a-z][a-z0-9_]{0,39}` y no tiene default. Los
ejemplos `agro_auth_offline_*` son exclusivamente de tests; no son nombres reales.
Realm es development/test/preview/production. Cada aplicación/deployment aislado
debe recibir el namespace/store apropiado; no basta compartir el realm preview
entre branches que deban permanecer aisladas.

Los IDs de usuario/cliente son las **claves lógicas string del puerto existente**,
no una decisión sobre el BSON de usuarios/clientes reales. Su mapeo canónico debe
aprobarse en BE-02. `_id` técnico no se devuelve por el puerto ni por HTTP.
Las fechas lógicas siguen epoch ms; los mappers verifican BSON Date antes de
convertir. No se leyeron ni convirtieron históricos/datos reales.

No se guarda Bearer, nonce original, challenge original, ID token, password,
perfil completo, IP o User-Agent. Sesión activa/revocada comparten colección; no
hace falta una colección por estado. Solo hay caché de metadatos de modelos por
Connection/prefijo, sin sesiones/usuarios en memoria productiva.

## 5. Índices propuestos y preparación

| Colección | Índice | Estado |
|---|---|---|
| Challenges | `_id` único incorporado, clave realm:digest | Requerido por readiness |
| Sessions | `_id` único incorporado, clave realm:id | Requerido por readiness |
| Sessions | `{realm:1,digest:1}`, unique | Requerido; sin sparse, partial, hidden ni collation ajena a simple |
| Challenges | `{expiresAt:1}`, expireAfterSeconds:0 | Declarado como propuesta; no se crea ni es requisito de autorización |
| Sessions | `{absoluteExpiresAt:1}`, expireAfterSeconds:0 | Declarado como propuesta; retención a aprobar |

La factory lee `listIndexes` y rechaza sin exponer repositorio si faltan las
restricciones únicas, la conexión no está abierta o falla la lectura. No llama a
createCollection, createIndexes, syncIndexes ni comandos de migración. AutoCreate,
autoIndex y bufferCommands son false en ambos schemas. El prefijo no puede
reutilizar un modelo ajeno registrado previamente.

La comprobación es una fotografía inicial, **no monitoriza DDL posterior**.
Se requiere aprobar colecciones de autenticación sin sharding para la propuesta
actual, o rediseñar/verificar las restricciones para la shard key real: no se
afirma unicidad global de `_id` en cualquier topología. La creación/aprobación de
índices queda fuera de esta tarea. Si una colección se elimina después de readiness,
un insert nativo podría crearla implícitamente según permisos/topología: el ciclo
de vida del namespace debe controlarse antes de habilitar. No se garantiza resolver
esa carrera administrativa con la comprobación inicial.

## 6. Operaciones y concurrencia

| Operación | Selección/actualización implementada | Resultado y condición |
|---|---|---|
| Crear challenge/sesión | Validación Zod + documento Mongoose.validate; insertOne tipado del driver con writeConcern majority/journal | Exige acknowledged e insertedId esperado; no upsert ni retry de aplicación |
| Buscar challenge | `_id=realm:digest`, realm; proyección cerrada, lean | Verifica identidad del record y convierte Date→epoch |
| Reclamar challenge | `_id`, realm, digest, nonceDigest, consumedAt null escalar, expiresAt>instante cliente y `$$NOW` | Un updateOne con $set consumedAt; solo modifiedCount=1 es éxito |
| Buscar sesión | realm+digest único, o `_id=realm:id`+realm | No se acepta Bearer en lugar de digest; output exacto validado |
| Actualizar actividad | `_id`, realm, no revocada, creada y no vencida en snapshot; absoluta>=candidato | findOneAndUpdate con `$max` idle y returnDocument after; no toca binding/revokedAt |
| Revocar | realm+digest, revokedAt null escalar | $set primera fecha; durable/idempotente, no requiere pertenencia activa ni upsert |

Se usan operaciones sobre un documento con predicados de estado, no locks de
proceso ni read-modify-save de snapshots. Los tests de dos workers usan Connections
Mongoose independientes y un store simulado compartido. **No demuestran que MongoDB
real haya ejecutado la atomicidad, persistido un journal o replicado una escritura.**

Los predicados `$$NOW` son comprobaciones de tiempo en el snapshot del comando,
no una promesa de exactitud de reloj durante toda espera interna/red/lock. Se
mantienen los rechecks de BE-09.2 antes/después de awaits. Los relojes requieren
sincronización. El TTL físico es limpieza eventual; no decide autorización.

Lecturas solicitan primary/majority y collation simple; updates e inserts solicitan
writeConcern majority con journal y wtimeout. maxTimeMS acota procesamiento del
servidor en consultas, actualizaciones y lectura de índices. Wtimeout es espera de
confirmación, **no un deadline completo de login/driver**. El connect timeout/pool
se mantiene en el manager existente; deadlines totales/cancelación quedan pendientes.

Pérdida de confirmación después de claim deja intento consumido: no se reintenta
para crear otra sesión. Un insert/response parcialmente confirmado puede dejar
sesión huérfana sin token entregado, como BE-09.2. El driver/servidor puede tener
retryable writes propios: deben verificarse con la configuración/topología real;
no se afirma que esta tarea los haya deshabilitado o probado.

## 7. Catálogo lógico y pertenencia

Propuesta mínima: un usuario con principal Google issuer/sub, ID interno, nombre,
email descriptivo, active, securityVersion y updatedAt; pertenencia embebida
`{clientId,active,updatedAt}|null`. Cliente lógico: ID, nombre, active y updatedAt.
No se propone una colección extra de memberships para una sola pertenencia.
En este contrato lógico membership.updatedAt no supera user.updatedAt. Estos campos
no aprueban un schema BSON ni sustituyen evidencia Atlas.

Store de lectura obligatorio:

- findUserByPrincipal({realm,issuer,subject}); sin lookup por email.
- findUserById({realm,userId}).
- findClientById({realm,clientId}), donde clientId viene de la pertenencia persistida.

El adaptador congela queries y resultados, valida shapes/IDs, no asigna cliente
default, no crea usuarios ni incluye metadata de almacenamiento en CatalogueUser.
Usuario desconocido → null; inactivo/sin pertenencia/cliente ausente → sin cliente
autorizado. Cliente deshabilitado se devuelve inactivo. SessionService conserva
403 al login no aprovisionado y 401 en nuevas admisiones con sesión inválida.

Las búsquedas iniciales de autenticación se acotan por principal o ID exacto y realm,
porque aún no existe cliente autenticado. No son consultas de negocio sin scope.
Después de resolverlo, BE-09.1 fija contexto y exige clientId en los repositories
de recursos. Se probaron A/B, IDs ajenos y filtros del scoped repository existente;
no se implementaron consultas físicas a campos/áreas/dispositivos/mediciones.

La pertenencia se captura en sesión y se revalida por request. El writer futuro
de catálogo debe incrementar securityVersion atómicamente en cambios que invaliden
sesiones, incluyendo revocación/reasignación/identidad. **No se implementa ese writer**.
Deshabilitar/reactivar un flag sin incrementar versión podría volver a admitir
sesiones antiguas aún vigentes: no se promete revocación global permanente solo
por flags. Usuario y cliente se leen por separado, sin transacción multi-documento;
no hay snapshot atómico catálogo+sesión ni cancelación de requests ya admitidos.

Índices candidatos del catálogo, no creados: usuario único por realm+issuer+sub y
por realm+ID lógico; cliente único por realm+ID. Email no será clave de identidad.
La equivalencia con usuarios/clientes actuales, tipos BSON y operaciones de
aprovisionamiento requieren BE-02; rutas/DTO/errores/UX requieren BE-03/FE.

## 8. Auditoría, defecto y corrección

**F09.3-01 — severidad baja, integridad ante documentos malformados:** el primer
filtro de consumedAt/revokedAt usaba query `$type:10` para null. MongoDB también
evalúa elementos de arrays; una fila con `[null]` podía consumirse o actualizarse
en lugar de ser rechazada. P18 reprodujo el fallo en el simulador ajustado a esa
semántica documentada: true donde se esperaba false.

Se agregó `$expr` con `$type` de agregación == 'null' para exigir que el campo
completo sea null escalar, excluyendo arrays y ausencias, en claim/touch/revoke.
P18 aprobó después; no se cambiaron expectativas anteriores ni se operó sobre DB
real. BE-09.2 ya rechazaba records malformados al leerlos antes de autenticar: no
se presenta como un bypass público demostrado ni como incidente productivo.

También se verifican acknowledgements negativos, errores de driver/índices, pérdida
de conexión sin buffering, datos BSON inválidos y respuestas de catálogo ajenas.
Errores I/O se descartan y generan DEPENDENCY_UNAVAILABLE; un resultado de adapter
malformado genera INTERNAL_ERROR seguro. La frontera callPort existente puede
normalizar errores internos de puertos a 503; no se propagan diagnósticos originales.
No se identifican hallazgos altos/críticos locales abiertos en el alcance revisado.

## 9. Pruebas y comandos reales

| Comprobación | Resultado |
|---|---|
| git fetch origin, comparación de base | Correcto; HEAD=origin/dev=3ac72ab, árbol inicial limpio |
| npm ci --no-audit --no-fund | Dos rondas correctas, sin cambiar lock; 120 paquetes, warning transitivo node-domexception 1.0.0 |
| npm run typecheck | Exit 0, TypeScript strict/NodeNext |
| npm run build | Exit 0 |
| npm test | **252/252**, 220 anteriores intactas + 32 nuevas; cero fallos/skips/canceladas |
| Suite nueva individual | **32/32**: P01…P19, K01…K08, I01…I05 |
| Regresión P18 antes/después | Falló antes; aprobó después de corregir el filtro |
| Comparador HTTP contra 3ac72ab | **13/13 equivalentes**, cero cambios intencionales nuevos |
| git diff --check y whitespace de nuevos | Sin errores |
| Grafo/AST de 41 archivos src | Sin any, sin ciclos estáticos; nuevos modelos/repositorio y auth router no alcanzables desde app.ts |
| Archivos previos/dependencias | Diez archivos de pruebas y documentos BE-09 históricos sin cambios; package y lock iguales a HEAD |
| Respaldos | 22 originales/copias y 21 archivos históricos verificados por SHA256 |

El código de test usa Mongoose 9.12.2 real con db.collection simulado debajo del
casting/query/model validation. No usa mongodb-memory-server ni instala MongoDB.
Las Maps están en ese archivo de test, nunca src ni un selector de entorno.
Barreras/promesas controladas, sin sleeps arbitrarios ni estrés externo.

I05 construye Express aislado con la única infraestructura BE-08 y router BE-09.2:
challenge/login/current/logout, 204 vacío, siguiente 401, DB caída 503 y sink sin
tokens, nonce, cookies, URI, perfil o cuerpo. Default app no se modifica.
La regresión HTTP cubre health GET/HEAD, Origin permitido/denegado/slash/subdominio,
wildcard, allowlist vacía con/sin Origin, OPTIONS, 404 y 500. No se probó una API
remota, GIS real, Atlas, replicación, failover, TTL físico ni Vercel Preview.

## 10. Riesgos y gates antes de habilitar

1. Aprobar estructura física de autenticación y namespace; no se aprueba por estar
   codificada. Aprovisionar en entorno aislado autorizado y verificar índices,
   validators BSON, topología sin sharding o restricciones equivalentes y permisos.
2. Implementar el store físico del catálogo y writer de aprovisionamiento/versionado
   aprobados por BE-02, sin confiar en telemetría o IDs públicos para pertenencia.
3. Probar MongoDB real: dos clientes/workers, duplicados, pérdida de ACK/red,
   concurrencia, majority/journal, failover/rollback, $$NOW y TTL/retención. Los tests
   actuales solo verifican comandos, integración y comportamiento del simulador.
4. Aprobar FE/BE-03, GIS/origins y flujo de sesión; mantener fixes FE y XSS/Bearer
   de BE-09.2 como pendientes. No se modificó frontend ni se aceptan credenciales
   artificiales en rutas productivas.
5. Implementar limiter distribuido, deadlines/cancelación reales y presupuesto total;
   revisar debug/logging Mongoose en configuración operativa. No hay timeout global
   nuevo ni garantía de deshacer escrituras al abortar HTTP.
6. Validar montaje y variables en Preview autorizado, con evidencia de entorno y
   SHA, sin inferir Production por nombre. No se modificó Vercel ni main.

Lista para auditoría de BE-09.3 y posterior revisión/integración como infraestructura
inactiva. No lista para autenticación productiva ni para cerrar BE-09. Sin commit,
push o PR; trabajo local en dev, índice vacío. No se inició BE-10.

## 11. Fuentes técnicas

- [Mongoose: conexiones y buffering](https://mongoosejs.com/docs/connections.html).
- [Mongoose: schemas y auto-DDL](https://mongoosejs.com/docs/guide.html).
- [Mongoose: findOneAndUpdate y returnDocument](https://mongoosejs.com/docs/tutorials/findoneandupdate.html).
- [MongoDB: atomicidad por documento](https://www.mongodb.com/docs/manual/core/write-operations-atomicity/).
- [MongoDB: max](https://www.mongodb.com/docs/manual/reference/operator/update/max/).
- [MongoDB: TTL requiere fechas](https://www.mongodb.com/docs/manual/core/index-ttl/).
- [MongoDB: variables y NOW](https://www.mongodb.com/docs/manual/reference/aggregation-variables/).
- [MongoDB: type query](https://www.mongodb.com/docs/manual/reference/operator/query/type/) y
  [type expresión](https://www.mongodb.com/docs/manual/reference/operator/aggregation/type/).

La documentación fundamenta las operaciones propuestas; no sustituye evidencia
de una instancia real autorizada. Trazabilidad detallada en la
[matriz BE-09.3](MATRIZ_BE09_3_PERSISTENCIA_SEGURIDAD.md).

## Anexo posterior — Auditoría BE-09.3A, 19/11/2026

Estado actual: **266/266**, 252 anteriores +14, typecheck/build correctos y 13/13
HTTP iguales. Se conservan los resultados anteriores como historia de BE-09.3.
La auditoría corrigió guardias de campos escalares y fechas en mutaciones para
excluir arrays en realm/digest/nonce/id/createdAt, y exigió acknowledged boolean true
en inserts. Cuatro regresiones fallaron antes y aprobaron después. P18 de null
escalar se conserva, sin modificar cuerpos/expectativas de los 32 tests previos.

Se explicitó que el store físico debe rechazar identidades ambiguas; devolver
un solo record no prueba ausencia de duplicados. Una invalidación de catálogo
no cancela necesariamente un touch ya en curso: la autorización final se rechaza,
pero no se garantiza ausencia absoluta de esa escritura entre stores distintos.
Writer/versionado/consistencia real siguen bloqueados por BE-02.

No se identificó instancia local autorizada y aislada. La sonda manual
`scripts/audit-auth-mongodb-local.ts` queda preparada con opt-in, loopback directo,
DB nueva aleatoria y limpieza de colecciones propias. Solo se probó su rechazo
sin opt-in, no se ejecutaron pruebas positivas reales ni se observó una versión
MongoDB. Instrucciones y límites en [auditoría A](INFORME_BE09_3A_AUDITORIA_FINAL.md)
y [trazabilidad A](MATRIZ_BE09_3A_TRAZABILIDAD.md).

Lista para revisión/integración como infraestructura inactiva; no habilitar auth
productiva. Sin publicación, despliegue o acceso Atlas; BE-09 parcial.
