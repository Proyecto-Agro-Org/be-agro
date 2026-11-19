# BE-09.5 — Implementación del catálogo usuario-cliente

19/11/2026. Trabajo **local sin commit**, en dev, base
`0f3bb209cf4b762da3bf8b6235a48c63727598af`. D01–D04 se usan como diseño de trabajo
autorizado para esta implementación aislada; no constituyen aprobación del equipo,
modelo agronómico BE-02 aprobado, migración ni habilitación productiva.

**Actualización BE-09.5A:** la auditoría final conserva312 pruebas y agrega8 (total320/320),
con13/13 HTTP equivalentes. Altas/revocación pasan a recibos persistentes explícitos y
checkpoint de recuperación. El detalle siguiente conserva la evidencia de la etapa BE-09.5
previa; su corrección basada en validar undefined se reemplaza por los recibos de BE-09.5A.
Consultar [auditoría final](INFORME_BE09_5A_AUDITORIA_FINAL.md) para el estado técnico vigente;
las menciones a sin commit/publicación describen aquella fase local, no un bloqueo nuevo.

## Resultado y estados

| Estado | Evidencia |
| --- | --- |
| Implementado | Dos modelos físicos Mongoose del catálogo auth, mappers BSON, store de lectura, writer CAS, invalidación de sesiones y sonda opt-in |
| Validado localmente | npm ci, typecheck, build, **312/312 pruebas** y **13/13 escenarios HTTP equivalentes**; sin fallos, canceladas ni skips |
| No probado en MongoDB real | Unicidad del servidor, validadores JSON Schema, CAS distribuido, majority/journal, TTL, failover y ACK/red perdidos |
| Pendiente de aprobación externa | Mapeo catálogo auth a cliente agronómico, administración/provisión real, políticas FE/GIS/operación y acuerdos de BE-09.4 |
| Pendiente de activación | App default no importa/monta autenticación ni estos repositorios; health continúa público |

Se repitió la base previa: 266/266. Las 46 ejecuciones nuevas pertenecen a C01–C37
(C05 incluye diez casos BSON); las 266 anteriores se conservaron sin modificar sus tests.
El resultado final no utiliza el conteo histórico como reemplazo de ejecución nueva.

## Archivos implementados y responsabilidades

| Archivo | Función |
| --- | --- |
| [identity-catalogue.models.ts](src/models/identity-catalogue.models.ts) | Modelos de usuarios y clientes exclusivos del catálogo de autenticación |
| [identity-catalogue.validators.ts](src/models/identity-catalogue.validators.ts) | Especificaciones declarativas de validadores BSON para inicialización autorizada |
| [identity-catalogue.schemas.ts](src/auth/identity-catalogue.schemas.ts) | Schemas Zod lógicos, físicos y de versiones; validación runtime |
| [identity-catalogue-admin.contracts.ts](src/auth/identity-catalogue-admin.contracts.ts) | Ports administrativos y de revocación, ligados a realm |
| [identity-catalogue.mapper.ts](src/repositories/identity-catalogue.mapper.ts) | BSON Date ↔ epoch, IDs, null, versiones y snapshots lógicos inmutables |
| [mongoose-identity-catalogue.store.ts](src/repositories/mongoose-identity-catalogue.store.ts) | Adaptador real sobre Connection Mongoose abierta, consultas/índices/CAS nativos |
| [identity-catalogue-admin.service.ts](src/services/identity-catalogue-admin.service.ts) | Operaciones internas, versión, pertenencia y coordinación de limpieza |
| [mongoose-session-invalidator.repository.ts](src/repositories/mongoose-session-invalidator.repository.ts) | Revocación posterior de versiones antiguas de un usuario |
| [identity-catalogue.contracts.ts](src/auth/identity-catalogue.contracts.ts) | Metadata interna de generación, sin cambios de contratos HTTP |
| [identity-catalogue.repository.ts](src/repositories/identity-catalogue.repository.ts) | Revalidación del cliente y comparación de generaciones |
| [identity-catalogue.test.js](test/identity-catalogue.test.js) | Casos deterministas y regresiones con schemas Mongoose reales y driver simulado |
| [audit-catalogue-mongodb-local.ts](scripts/audit-catalogue-mongodb-local.ts) | Prueba positiva manual futura, DB local descartable, doble opt-in |

README y plan se actualizan solo para describir el estado real. No se modificaron
app/router/controller/DTO HTTP, servicio de sesiones previo, dependencias, lockfile,
frontend, ingesta, Vercel ni modelos de Campo/Área/Dispositivo/Medición.

## Modelo físico aislado

No existía otro catálogo físico reutilizable: únicamente contratos/lector de identidad,
puertos de autorización, modelos técnicos de sesiones/challenges y repositorios acotados.
Se reutilizan esos contratos y servicios. Los modelos nuevos **no representan definitivamente
el Cliente agronómico** ni prueban la estructura de Atlas.

El prefix `agro_auth_…` se recibe explícitamente mediante la configuración existente;
colecciones `<prefix>_users` y `<prefix>_clients`, sin fallback a colecciones agronómicas.
Cada documento tiene `_id` string `realm:id` y el scope enum development/test/preview/production.
No hay nombres físicos productivos escogidos ni datos externos importados.

| Modelo/campo | Tipo físico / validación |
| --- | --- |
| Usuario realm/id/issuer/subject/name/email | Strings; claves lógicas 1..256 sin espacios extremos ni controles; issuer canónico Google, email válido máximo320 |
| Usuario active | Boolean requerido, no string/truthy/default permisivo |
| Usuario securityVersion | Número BSON int/long/double representable como entero seguro no negativo; nunca BigInt/Decimal/string coercionado |
| Usuario updatedAt | BSON Date válido, epoch no negativo al mapear |
| Usuario membership | Objeto estricto o null explícito; ausente/undefined/array se rechazan |
| membership clientId/active/updatedAt | String lógico, boolean, Date; updatedAt no posterior al del usuario |
| membership clientSecurityVersion | Entero seguro requerido del cliente al vincular; snapshot de generación, no dato HTTP |
| Cliente id/realm/name/active/updatedAt | String, scope enum, string, boolean y Date, con las mismas barreras |
| Cliente securityVersion | Generación de seguridad monótona; requerida también para clientes inactivos |

Mongoose usa strict/strictQuery throw, cast deshabilitado en escalares, autoCreate/autoIndex/
bufferCommands false y versionKey false. Validación Zod de entradas y BSON **antes** de persistir,
hook del modelo y mapper de salida evitan depender solo de defaults/casting Mongoose.
Los validadores JSON Schema declarados añaden tipos escalares, campos requeridos, null y rango
entero; no sustituyen el mapper ni las comprobaciones de relaciones. Su ejecución real está pendiente.
El driver puede promover int/long seguros a Number; valores no seguros o BSON inesperado se rechazan.

## Índices y preparación controlada

| Colección | Índice declarado |
| --- | --- |
| users | unique realm + id (`auth_user_id_unique`) |
| users | unique realm + issuer + subject (`auth_principal_unique`) |
| users | realm + membership.clientId + id, no único (`auth_membership_lookup`) |
| clients | unique realm + id (`auth_client_id_unique`) |

Además se exige `_id` único de MongoDB. Collation simple; no unicidad parcial/sparse/hidden.
No índice único por email, ni TTL de usuario/cliente. No hay varios clientes por usuario:
pertenencia es un solo objeto nullable, jamás array ni selección del primer resultado.

La factory realiza listIndexes y rechaza ausencia de índices únicos completos antes de servir.
El índice no único administrativo está declarado; no es una garantía de autorización ni se exige
para las búsquedas de identidad por clave. Se valida al inicializar el namespace de prueba.
Las declaraciones de índices del modelo **no los crean**.

Inicialización futura, no ejecutada aquí:

1. Operador autoriza una instancia/base/namespace nuevos y aislados; confirma versión/topología,
   ausencia de túneles y permisos de fixtures, DDL y limpieza. No usar Atlas ni un catálogo ajeno.
2. Crear explícitamente users/clients con collation simple, validadores exportados, validationLevel
   strict y validationAction error. Preparar también las colecciones de sesiones/challenges si se
   prueba la integración completa. Sin syncIndexes ni migración de datos existentes.
3. Crear explícitamente los índices declarados y revisar listIndexes/validadores/opciones reales.
   Duplicados/tipos incompatibles bloquean inicialización; nunca borrar/seleccionar datos arbitrariamente.
4. Abrir conexión explícita; construir store y repositorio de sesiones. La factory solo lee metadata.
   Inyectar store al lector y administración al servicio interno, con el mismo realm del invalidator.
5. Ejecutar pruebas positivas autorizadas y la campaña distribuida antes de considerar Preview.

El runtime no crea colecciones/índices ni realiza seeds. Cambios externos posteriores de DDL no
se monitorizan continuamente; los permisos operativos deben impedirlos durante el servicio.

## Repositorio de lectura y CAS

- Lecturas exactas por realm/issuer/sub, realm/id de usuario o realm/id de cliente. Sin búsquedas
  de autenticación por email y sin alta JIT de Google. No se devuelve Mongoose/BSON como DTO público.
- Se usa cursor limitado a dos resultados: cero→null, uno→mapper estricto, dos→error seguro.
  Así un duplicado inesperado no se oculta mediante findOne, incluso en el doble corrupto de prueba.
- Native driver bajo una Connection Mongoose evita casting implícito de BSON inválido en lectura.
  Primary/readConcern majority/collation simple/maxTimeMS; validación de scopes y strings antes del query.
- Altas con insertOne, ACK booleano true e insertedId exacto; error11000→CONFLICT seguro. La unicidad
  real depende de índices del servidor, no de consultar primero si existe el usuario.
- CAS compara realm/id/versión y cada campo del snapshot anterior como valor BSON completo mediante
  `$expr/$literal`. Cambia únicamente campos mutables con `$set`, versión+1 y tiempo no decreciente.
  No upsert, identidad/ID no reemplazables y no escrituras ciegas. Un perdedor recibe CONFLICT.
- Retorno after debe corresponder al siguiente registro esperado. Errores nativos, objetos hostiles,
  causas y getters no se conservan en errores públicos del servicio/store. No se registran documentos.

## Writer administrativo interno

Sin endpoints ni roles administrativos nuevos. Son ports confiables para composición explícita,
no capacidades otorgadas al navegador. El servicio no depende de Express ni de SDK/queries MongoDB.

| Operación | Resultado/control |
| --- | --- |
| createClient | Registro aislado autorizado explícitamente; versión0, ID único; no se llama al importar/login |
| createUser | Identidad Google previamente autorizada; cliente existente/activo o null; versión0 y generación capturada |
| changeMembership | Vincula/revincula un cliente activo o desvincula con null; CAS e incremento siempre, incluso al volver al mismo cliente |
| setUserActive | Baja/alta mediante CAS e incremento; habilitar usuario no corrige una pertenencia obsoleta automáticamente |
| invalidateUser | Incrementa versión sin cambiar ámbito para invalidar sesiones existentes |
| setClientActive | Baja/alta del cliente con CAS y nueva generación en ambos sentidos |
| retryRevocation | Reintenta limpieza anterior, validando que la versión no sea futura; idempotente |

Las operaciones de usuario devuelven revocation confirmed/pending. Estado y versión se persisten
antes de intentar barrer sesiones. El barrido afecta solo realm/usuario y versiones inferiores a la
nueva; no revoca nuevas sesiones válidas creadas después. Fallos o respuestas de port malformadas
dejan pending y **no revierten la invalidación**. Si el ACK del propio CAS se pierde, se rechaza
la operación como no confirmada: releer el estado antes de otro comando; no reintentar ciegamente
con una versión nueva. No hay cola durable automática ni endpoint de reintentos.

## Protocolo de reactivación e integración con BE-09.1/2/3

Al vincular: membership.clientSecurityVersion = client.securityVersion. El lector compara ambas
en cada resolución del cliente. Un cambio de estado del cliente incrementa su generación:
las pertenencias previas quedan obsoletas incluso después de reactivarlo. Se debe revincular cada
usuario mediante su CAS; eso incrementa user.securityVersion. **No hay barrido multiusuario
obligatorio para negar acceso**, ni se promete una transacción global para reactivarlos.

Ejemplo determinista: sesión usuario versión0/clienteA generación0; baja A→generación1;
alta A→generación2; pertenencia0 sigue inválida. Revincular usuario→versión1/pertenencia2;
la sesión versión0 sigue inválida aunque A sea otra vez el cliente. A→B→A de usuario también
incrementa siempre su versión. Se prohíbe borrar/reusar IDs o restablecer contadores a0.

El servicio de sesiones existente conserva realm, userId, clientId, securityVersion y expiraciones.
Se reutiliza sin cambios; el catálogo actualizado deniega generaciones obsoletas antes de otorgar
cliente válido. Los campos nuevos son metadata interna, no DTO/contrato HTTP.
Compatibilidad: ports lógicos heredados pueden omitir ambas generaciones; **el store físico
BE-09.5 las exige** y una mezcla/ausencia física nunca autoriza. No desplegar ports legacy/fakes
como sustituto del catálogo físico ni confiar en TypeScript para validar esos valores.

Semántica D03: el touch contable ya iniciado puede finalizar después de la baja, pero no devuelve
permisos cuando la posterior revalidación observa el cambio. Una capacidad ya admitida puede
completar trabajo dentro de su lease. No se promete cancelación instantánea, snapshot conjunto,
linealizabilidad global ni cero I/O después del ACK de baja. Requiere la política/SLA y pruebas
reales correspondientes antes de Preview; majority no constituye atomicidad entre stores.

## Auditoría y defectos corregidos en el código nuevo

| Hallazgo | Reproducción previa al arreglo | Corrección |
| --- | --- | --- |
| F95-01 — excepción hostil podía escapar con diagnóstico | C22 falló: getter code de ApplicationError lanzó el marcador privado | Leer solo descriptor de datos propio, verificar código, reconstruir error seguro; proxies/getters fallidos→503 |
| F95-02 — un port void malformado se consideraba confirmado | C36 falló: revokeBeforeVersion devolvió false y se reportó confirmed | Validar undefined en revocación y altas; limpieza anómala→pending, alta anómala→error seguro |
| F95-03 — composición administrativa aceptaba realm distinto | C37 falló: factory administrativa no rechazaba production con store test | Ports con realm explícito e igualdad comprobada en construcción; rechazo antes de escritura |

Son hallazgos de esta implementación local, no incidentes observados en Production. Sus regresiones
se ejecutaron individualmente antes/después y luego se repitió toda la suite. No se detectaron
hallazgos altos/críticos locales pendientes; esto no certifica seguridad distribuida ni aprobación externa.

## Validaciones ejecutadas

| Comprobación | Resultado real |
| --- | --- |
| npm ci | Exit0, 120 paquetes, audit0 vulnerabilidades reportadas; package/lock intactos |
| npm run typecheck | Exit0, TypeScript estricto NodeNext |
| npm run build | Exit0 |
| npm test | **312/312**, 266 previas +46 nuevas, cero skips/cancelaciones/fallos |
| Diferencial HTTP contra base0f3bb20 | **13/13 compatibles**, cero cambios intencionales/regresiones; localhost efímero únicamente |
| AST/dependencias | 52 módulos TS revisados, cero any explícitos/ciclos runtime; app alcanza13 módulos sin auth/catálogo |
| Whitespace/documentos | git diff --check y controles de archivos nuevos, referencias y coherencia |
| MongoDB positivo / GIS / Preview | **No ejecutados** |

HTTP cubierto: GET/HEAD health, Origin permitido/denegado/slash/subdominio, wildcard, allowlist vacía
sin/con Origin, OPTIONS, ruta desconocida, POST health y error500. Status, body y headers legacy
comparados con la base; endpoint health200 y JSON status ok preservados.
Evidencia local fuera de Git: `.local-consolidacion/integraciones/be09-5-local-20261119/`
(logs, hash inicial, estructura y diferencial HTTP). No se publica en esta tarea.

## MongoDB real opt-in y pendientes

La sonda nueva exige **ambos** AGRO_AUTH_LOCAL_AUDIT=AUTHORIZED_DISPOSABLE_LOOPBACK_ONLY y
AGRO_CATALOGUE_LOCAL_AUDIT=AUTHORIZED_DISPOSABLE_CATALOGUE_ONLY. Valida puerto/replica set,
ignora MONGODB_URI, usa 127.0.0.1/directConnection, DB aleatoria nueva `agro_catalogue_audit_<24hex>`
y cuatro colecciones `agro_auth_catalogue_manual_{users,clients,sessions,challenges}`.
No permite URI/host/credenciales/base existentes desde parámetros públicos.

Solo tras autorización expresa de instancia descartable exclusiva, en PowerShell dedicado con
estas variables inicialmente ausentes (ejemplo futuro, **no ejecutado**):

```powershell
npm run build
$env:AGRO_AUTH_LOCAL_AUDIT = 'AUTHORIZED_DISPOSABLE_LOOPBACK_ONLY'
$env:AGRO_CATALOGUE_LOCAL_AUDIT = 'AUTHORIZED_DISPOSABLE_CATALOGUE_ONLY'
$env:AGRO_AUTH_LOCAL_PORT = '27019' # Sustituir por el puerto autorizado.
try {
    node dist/scripts/audit-catalogue-mongodb-local.js
    if ($LASTEXITCODE -ne 0) { throw 'Sonda no aprobada; revisar limpieza propia' }
} finally {
    Remove-Item Env:AGRO_AUTH_LOCAL_AUDIT -ErrorAction SilentlyContinue
    Remove-Item Env:AGRO_CATALOGUE_LOCAL_AUDIT -ErrorAction SilentlyContinue
    Remove-Item Env:AGRO_AUTH_LOCAL_PORT -ErrorAction SilentlyContinue
}
```

Replica set local opcional mediante AGRO_AUTH_LOCAL_REPLICA_SET validado; si se utiliza,
gestionarlo en la misma sesión dedicada y restaurar/eliminar la variable al terminar.
La sonda crea validadores/índices **solo en sus colecciones nuevas**, prueba dos conexiones,
dos altas del mismo principal y CAS, integración de sesiones, reactivación y BSON inválido.
Limpia únicamente las cuatro colecciones que creó, comprobando DB/nombres; nunca dropDatabase.
Kill o fallo de finally exige inspección/limpieza manual solo de esos objetos tras verificar propiedad.
Un rechazo sin opt-in fue ejecutado por C35, antes de conectar; no equivale a una sonda positiva.

Pendientes: ejecutar la sonda autorizada, certificar MongoDB/JSON Schema/índices/CAS, dos procesos OS,
fallos parciales/replicación/durabilidad/retries/deadlines y campaña M01–M12 de BE-09.4.
Dos Connections de un proceso no certifican distribución. No se instalaron servidores ni dependencias nuevas.

## Riesgos residuales, BE-02 y Preview

- Exigir escritor único/protocolo compartido para cambios de seguridad. Escrituras directas,
  eliminación/reuso de IDs, restaurar catálogo sin invalidar sesiones o reiniciar versiones pueden
  romper invariantes. Permisos, recuperación y runbook de revocation pending siguen pendientes.
- Lecturas separadas, latencia de replicación y requests ya admitidos tienen los límites D03.
  No hay transacción entre catálogo/sesiones, ni cola durable automática para limpieza fallida.
- maxTimeMS/wtimeout son límites por operación, no deadline global/cancelación distribuida.
- Debe aprobarse la correlación con el cliente real BE-02. No crear/alterar modelos agronómicos ni
  migrar datos por la coincidencia de nombres. Atlas no se consultó.
- Preview exige catálogo/mapeo aprobados, MongoDB real validado, contratos FE/BE, correcciones F01–F04,
  GIS de prueba, limiter compartido, observabilidad segura y permiso de activación separado.
- Bearer/XSS, Google real, consentimiento, configuración Vercel y E2E remoto no se validan aquí.

**Recomendación:** lista para revisión técnica del cambio local y posterior PR Draft cuando se
autorice publicar; no lista para activar autenticación ni declarar BE-09 Done. Sin commit/push/PR,
nuevas ramas, deploy, accesos reales ni BE-10. Main, frontend, documentos BE-09.4 y respaldos preservados.

### Cierre de preservación

HEAD y origin/dev conservan0f3bb209cf4b762da3bf8b6235a48c63727598af;
main y origin/main conservan1bb20f76b7a739f42c75b37b9a64315276560ec1.
Cuatro archivos versionados modificados (README, plan, contrato lógico y lector), doce nuevos,
sin staging. Los otros113 archivos de la base conservan su SHA256 inicial, incluidos tests previos,
package/lock, app, contratos HTTP y los seis documentos BE-09.4.
Se verificaron22 originales/copias históricas y21 respaldos contra manifiestos, además de184
archivos versionados FE con huella agregada idéntica. El informe privado BE-05 permanece intacto.
Las16 referencias locales de los dos entregables nuevos resuelven a archivos existentes; checks
de whitespace para versionados/nuevos aprobados y sin secretos detectados en los archivos nuevos.
