# BE-09.4 — Preparación de integración real FE/BE/Google/MongoDB

Fecha: 19/11/2026. Estado: **paquete de propuestas listo para revisión; autenticación real
deshabilitada y BE-09 parcial**. Esta entrega solo crea documentación local; no habilita
integraciones, no cierra BE-02/03/09 y no comienza BE-10.

## 1. Estado comprobado y preservación

- Worktree: `C:\Users\CamilaGonzález\be-agro\.local-consolidacion\dev`.
- Rama dev, HEAD y origin/dev tras `git fetch origin`:
  `07f15511f26d3fce664d892dba7c8ea7bf48cfe1`. Árbol inicial limpio.
- Origin: repositorio universitario Proyecto-Agro-Org/be-agro por HTTPS.
- GitHub confirmó [PR #13](https://github.com/Proyecto-Agro-Org/be-agro/pull/13) cerrado/fusionado,
  base dev, merge `07f15511f26d3fce664d892dba7c8ea7bf48cfe1`, fecha 19/11/2026 UTC.
- main y origin/main: `1bb20f76b7a739f42c75b37b9a64315276560ec1`, sin modificación.
- FE inspeccionado en lectura, HEAD `daa72a828eb79aad0f09dcb7786a2c5a4adfd3bc`, árbol limpio.
- Informe privado BE-05, originales BE-09, snapshots de integración y respaldos preservados.
  No se incorporan a estos documentos sus contenidos privados ni se versionan copias.

README e IMPLEMENTATION_PLAN contienen secciones históricas del 17/11 que dicen que BE-09.2
no se inició y describen el estado preparatorio de consolidación. Eso no representa el estado
del código actual: BE-09.2 y BE-09.3 están integradas como infraestructura inactiva en dev.
No se alteró esa documentación histórica ni se marcaron casillas Done. La cronología se aclara
aquí usando PR #13 y los informes de implementación/auditoría posteriores.

## 2. Clasificación de evidencia

| Estado | Resultado |
| --- | --- |
| Implementado y verificado | Infraestructura BE-09.1/2/3 integrada, suites locales históricas 266/266 y diferencial HTTP13/13; inspección de código y contratos en esta entrega |
| Implementado sin prueba real | Verificador SDK Google, repository Mongoose, factory auth HTTP y sonda opt-in; sin Google real, servidor MongoDB real ni E2E Preview |
| Propuesto | Contrato mínimo de catálogo, cuatro operaciones FE/BE, política de consistencia, GIS por entorno, campaña MongoDB/E2E y etapas A–I |
| Pendiente de aprobación | D01–D08; no hay acuerdos nuevos implícitos por publicar/integrar infraestructura |
| Bloqueado | Catálogo físico/versionado, instancia autorizada, Google/orígenes, adaptación FE, limiter/operación y habilitación Preview |
| No aplicable | Roles por endpoint, MongoDB agronómico definitivo, password real, BE-10, cambios de main/Production |

**266/266 y 13/13 son evidencia histórica de BE-09.3B, no resultados ejecutados en BE-09.4.**
La tarea actual no reejecutó npm ci/typecheck/build/test ni tests FE: no cambió código.

## 3. Inspección y contratos reales

| Componente inspeccionado | Evidencia | Garantía/límite observado |
| --- | --- | --- |
| App default | [src/app.ts](src/app.ts) | health público, Express export default; no importa/monta auth router ni conecta Mongo/Google |
| Autorización BE-09.1 | [service](src/services/authorization.service.ts), [middleware](src/middlewares/request-authorization.middleware.ts), [repository acotado](src/repositories/client-scoped.repository.ts) | Contexto privado por request y filtros de cliente; no cliente confiable desde HTTP; capacidades ya admitidas no se cancelan globalmente por baja |
| Challenge y sesiones | [session.service.ts](src/services/session.service.ts), [contratos](src/auth/session.contracts.ts) | Secretos aleatorios32bytes, digest SHA256, consume explícito, expiración, sesión ligada a usuario/cliente/versión, logout revocable |
| Google | [adaptador](src/adapters/google-identity.adapter.ts) | SDK oficial, claves cacheadas, nonce/issuer/sub/audience/firma/tiempos, fallos sanitizados; DI solo confiable; sin activación al importar |
| Catálogo | [lector](src/repositories/identity-catalogue.repository.ts), [ports](src/auth/identity-catalogue.contracts.ts) | Lectura estricta y sin JIT/default de cliente; falta store físico y writer; no descubre duplicados ocultados por el store |
| Persistencia | [modelos](src/models/authentication.models.ts), [mapper](src/repositories/authentication-record.mapper.ts), [repo](src/repositories/mongoose-session.repository.ts) | Metadata auth únicamente, Date BSON propuesto, validación strict, guardias escalares, update condicional/max, ACK estricto, majority/journal y timeout de operación; sin DDL automático |
| Conexión | [manager](src/infrastructure/mongodb.ts), [config](src/config/mongodb.ts) | Apertura explícita compartida; cierre fallido bloquea worker; timeouts no equivalen a deadline end-to-end |
| HTTP | [router](src/routes/session.routes.ts), [DTO](src/dto/session.dto.ts), [infra](src/http/infrastructure.ts) | Cuatro operaciones aisladas, Origin POST exacto, no-store, ports de admisión obligatorios; nested errors solo con adaptador explícito, default legacy |
| Config auth | [authentication](src/config/authentication.ts), [persistence](src/config/authentication-persistence.ts), [.env.example](.env.example) | Realm/audience/orígenes/TTL explícitos; namespace sin default; placeholders, no composición productiva |
| MongoDB manual | [sonda](scripts/audit-auth-mongodb-local.ts) | Opt-in, loopback, DB nueva aleatoria y limpieza propia; no ejecutada positivamente; no certifica distribución |

Documentación contrastada: [BE-09.1](INFORME_BE09_1_INFRAESTRUCTURA_AUTORIZACION.md),
[BE-09.2A](INFORME_BE09_2A_DISENO_AUTENTICACION_REAL.md),
[BE-09.2B](INFORME_BE09_2B_IMPLEMENTACION_SESIONES.md),
[BE-09.2C](INFORME_BE09_2C_AUDITORIA_FINAL.md),
[BE-09.3](INFORME_BE09_3_PERSISTENCIA_Y_CATALOGO.md),
[BE-09.3A](INFORME_BE09_3A_AUDITORIA_FINAL.md),
[BE-02](INFORME_BE02_MODELO_DATOS.md), [BE-03](INFORME_BE03_CONTRATOS_API.md),
[OpenAPI propuesto](docs/openapi.json), [decisiones BE-03](docs/DECISIONES_BE03.md),
[especificación](ESPECIFICACION.md), [DoD](DEFINITION_OF_DONE.md),
[README](README.md), [plan vigente](IMPLEMENTATION_PLAN.md).
BE-02 no aporta inventario Atlas verificado; incorporar sus propuestas no aprobó nombres/BSON/IDs.
BE-03 tampoco aprueba automáticamente nuevos contratos de autenticación.

## 4. Decisiones técnicas recomendadas

1. **D01/D02:** ratificar un cliente vigente por usuario y principal único realm+issuer+sub;
   campos de contacto no autorizan. Cliente/IDs físicos requieren acuerdo BE-02. Alternativa
   multicliente documentada con impacto, sin implementarla unilateralmente.
2. **D03:** writer CAS con versión monótona y estado/pertenencia en una actualización por usuario,
   invalidación primero y revocación después; aceptar explícitamente límite de actividad en vuelo
   o aprobar coordinación fuerte antes de implementar. No hay atomicidad entre stores hoy.
3. **D04/D05:** cuatro rutas GIS callback/Bearer, identidad obligatoria, restore real y logout204;
   TTL, sesiones simultáneas, almacenamiento y errores requieren acuerdo FE/BE/Seguridad.
4. **D06/D07:** probar metadata con instancia exclusiva autorizada y GIS en entorno de prueba
   separado. No hace falta acceso productivo a Atlas para diseñar/probar esta infraestructura;
   sí hace falta resolver el catálogo confiable de cliente antes de habilitar integración real.
5. **D08:** limiter compartido, presupuesto de tiempos, diagnóstico seguro y rollback antes de Preview.

Detalle normativo propuesto en [catálogo y consistencia](CONTRATO_PROPUESTO_USUARIO_CLIENTE.md)
y [HTTP FE/BE](CONTRATO_PROPUESTO_AUTENTICACION_FE_BE.md). Ninguna recomendación se registra aprobada.

## 5. Frontend real y brechas

La inspección read-only confirma login email/password, Google demo y restore de identidad solo
MSW; modo real no integra GIS. AuthContext conserva usuario/cliente opcionales y las rutas se
protegen por presencia de token. Logout solo limpia estado local. Bearer viene de sessionStorage.
No hay proxy dev configurado en vite.config.ts; su URL localhost3000 es del entorno de test.
La base FE por defecto es /api/v1; el origen real debe acordarse, no inferirse de un test.

F01: 401 antiguo puede borrar sesión nueva. F02: fallo de storage deja token en memoria del
contexto pero el HTTP client no lo usa. F03: error anidado se interpreta como string/objeto
incorrecto. **F04 adicional:** apiFetch llama json() en204, incompatible con logout vacío.
Los cuatro están demostrados por código; no se modificó FE ni se ejecutó su suite.
El contrato HTTP incluye archivo/evidencia, corrección propuesta y regresión exigida por caso.
No se descubrió en esta revisión un nuevo defecto crítico independiente que autorice saltarse
las decisiones pendientes y modificar infraestructura. Esto no certifica ausencia de vulnerabilidades.

## 6. Google Identity Services: configuración y aprobación D07

### Flujo propuesto

Cliente OAuth de tipo **Web application**, callback JavaScript de GIS; FE pide challenge, configura
nonce de ese intento, recibe credential y hace POST JSON al BE. BE valida antes de consultar
catálogo. `sub` + issuer canónico es identidad; email no asigna cliente. El client ID web es
identificador público; este flujo de ID token no requiere client secret ni código OAuth de acceso
a APIs Google. No pedir credenciales en chat ni registrar tokens.

Proponer un único intento activo por página y generación de callback: no reutilizar nonce
entre intentos ni reconfigurar GIS mientras hay otro callback pendiente. La política de
inicialización/reintento debe probarse con la API GIS; no asumir aislamiento de dos configuraciones
globales simultáneas. Descartar respuestas de intentos anteriores sin iniciar sesión.

Google permite [callback o envío directo](https://developers.google.com/identity/gsi/web/guides/integrate).
Se recomienda callback para corresponder al router actual. Cambiar a form_post/redirect exige otro
contrato, incluidos los controles de [CSRF para envío directo](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token).
No afirmar que Origin+nonce de la propuesta implementa el double-submit cookie de otro flujo.

### Manifest de entorno a completar por responsables, no valores configurados

| Entorno | FE / Google | BE | Scope y gate |
| --- | --- | --- | --- |
| Desarrollo/test | Origen local exacto; localhost y127 son distintos; ID web de prueba | AUTH_ENVIRONMENT=development/test, GOOGLE_CLIENT_ID igual al FE y AUTH_ALLOWED_ORIGINS exactos | Instancia descartable/namespace aislado; cuentas de prueba; no credenciales reales aquí |
| Preview | Dominio HTTPS estable de prueba acordado, client ID web separado de Production, usuarios autorizados | realm preview, audiencia solo de ese cliente, origen FE exacto | DB/prefix aislados por despliegue/cohorte; realm preview por sí solo no separa varios Previews |
| Production | Origen HTTPS definitivo y client ID propio | realm production y allowlist propia | Gate I independiente; no activar en esta entrega |

El administrador registra los orígenes exactos en Google Cloud; no confundir origen FE,
URL API y redirect URI. Las URLs Preview efímeras requieren una estrategia aprobada, no wildcard.
Revisar CSP/COOP/popup/FedCM según [setup GIS](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid).
La CSP restrictiva del JSON backend no es plantilla para cargar GIS en FE.

Variables BE ya soportadas: AUTH_ENVIRONMENT, GOOGLE_CLIENT_ID, AUTH_ALLOWED_ORIGINS,
AUTH_LOGIN_CHALLENGE_MS, AUTH_SESSION_ABSOLUTE_MS, AUTH_SESSION_IDLE_MS. No hay flag runtime que
monte automáticamente auth; la composición futura requiere tarea/aprobación. Prefix de persistencia
se inyecta explícitamente; no inventar un envloader existente.
FE hoy solo tiene VITE_API_BASE_URL y VITE_USE_MOCKS relacionados con este flujo.
**VITE_GOOGLE_CLIENT_ID es nombre propuesto, no implementado.** El FE debe usar el mismo ID que
la audiencia BE; evitar mocks como interruptor de autenticación real.

### Validación y operación

El adaptador verifica firma con SDK oficial y claves de Google, issuer/audience/azp, expiración,
iat/nbf, nonce y email_verified si hay email. Skew default60s, configurable0..60s; un token
expirado dentro de tolerancia no debe confundirse con el caso E03 fuera de tolerancia.
Su nonce corresponde a la [opción GIS nonce](https://developers.google.com/identity/gsi/web/reference/js-reference).
Certificados se cachean por SDK y las aperturas concurrentes se comparten. Timeout3s y retries
de proveedor desactivados en interceptor; no equivalen a un deadline global del request.
Fallo de certificados→503 seguro, credencial inválida→401; FE renueva challenge cuando corresponde,
sin bucle de reintentos ni exponer el error original del proveedor.

Rotación de client ID/orígenes: preparar manifest versionado sin secretos, coordinar FE/BE,
cerrar nuevos intentos durante transición y descartar challenges de audiencia anterior. Definir
invalidación de sesiones existentes si cambia el límite de confianza: el registro de sesión
no guarda audience, por lo que cambiar GOOGLE_CLIENT_ID **no** revoca por sí solo sesiones Agro.
Probar rollback y separación de scopes antes de reabrir. Rotación de claves Google la maneja SDK;
su comportamiento online/caché/error sigue pendiente de prueba real autorizada.

El ID token Google prueba el login; el Bearer Agro posterior tiene expiración/revocación propia.
No se consulta Google en cada request ni se cierra Google al hacer logout Agro. No hay integración
de eventos de baja de cuenta Google ni step-up/auth_time; no prometer revocación continua del
proveedor. GIS real, consentimiento/usuarios de prueba y configuración no se inspeccionaron en consola.
Un deployment Vercel Success no valida audiencia, nonce, catálogo ni funcionamiento remoto.

## 7. MongoDB, consistencia y pruebas

No se ejecutó sonda ni se conectó a Atlas/otra instancia. La propuesta especifica condiciones
de autorización, comando futuro protegido y alcance de limpieza. Sonda positiva pendiente.
Dos Connections del mismo proceso no prueban concurrencia de procesos ni failover/durabilidad.
Campaña M01–M12: índices/TTL, consume único, revocación, max condicional, majority/journal,
ACK perdido, BSON malformado, writer CAS y revalidación. Gate completo en la
[matriz E2E/MongoDB](MATRIZ_BE09_4_E2E_Y_DEPENDENCIAS.md).

La carrera A10 sigue siendo límite real: touch iniciado puede completar tras baja del catálogo;
la autorización que observa la baja rechaza. Versionar/barrer reduce exposición, no proporciona
cancelación instantánea ni transacción entre stores. La alternativa fuerte necesita autoridad
compartida/fence y pruebas de conflicto; una transacción de solo lectura de usuario no basta.

Se proponen **22 escenarios E2E**, cada uno con precondiciones, acciones, resultado, nivel y
dependencia. No ejecutados; E15 no convierte la infraestructura de aislamiento en CRUD real.

## 8. Trabajo inmediato, bloqueos y orden

Se puede empezar ahora la revisión A/B de cardinalidad/consistencia/HTTP, inventario de
configuración GIS sin secretos y diseño de fixtures/harness. No se necesita esperar datos de
sensores/Agronomía para esas decisiones. Correcciones FE F01–F04 pueden implementarse después de
aprobar B usando fixtures, sin Google/Atlas reales.

Bloqueos de ejecución: esquema físico de identidad/cliente y writer; permiso sobre MongoDB
descartable; pruebas distribuidas; admin/config GIS; contrato FE; limiter compartido, deadlines,
observabilidad y autorización Preview. Revisión general BE-02/03 sigue pendiente, pero distinguir
el subconjunto identidad/cliente/HTTP necesario de magnitudes agronómicas ajenas a autenticación.

Orden A/B y preparación C/E/F en paralelo → D físico y F/E → G Preview autorizado → H E2E → I
evaluación Production separada. Gates y responsables detallados en el
[plan A–I](PLAN_BE09_4_IMPLEMENTACION_Y_APROBACIONES.md).
La próxima implementación de catálogo se destraba con A/D01–D03 más instancia C autorizada;
la FE con B/D04–D05; la sonda con D06. No basta aprobar genéricamente «seguir con auth».

## 9. Entregables y validación documental

Cinco documentos principales: este informe, [catálogo](CONTRATO_PROPUESTO_USUARIO_CLIENTE.md),
[contrato HTTP](CONTRATO_PROPUESTO_AUTENTICACION_FE_BE.md),
[matriz](MATRIZ_BE09_4_E2E_Y_DEPENDENCIAS.md) y
[plan](PLAN_BE09_4_IMPLEMENTACION_Y_APROBACIONES.md).
Adicionalmente, [resumen para el equipo](RESUMEN_BE09_4_DECISIONES_EQUIPO.md), solo decisiones a acordar.

Validación de cierre: referencias locales/archivos, JSON de ejemplos, 22 filas E2E, ocho decisiones,
etapas A–I, seis estados por documento, consistencia con router/DTO/config/ports y whitespace de
archivos nuevos; `git diff --check` para versionados. Ningún archivo de código/package/lock,
OpenAPI anterior, README o plan previo se cambia. No se reejecuta suite funcional por ser documentación.
Los resultados concretos de estos controles se registran en el apartado de cierre siguiente.

### Cierre de verificación

Controles ejecutados satisfactoriamente en BE-09.4:

- Seis Markdown nuevos locales: cinco obligatorios más resumen de decisiones; sin staging.
- 73 enlaces locales resuelven a archivos existentes; tres ejemplos JSON parsean. Los placeholders
  de secretos son intencionales: validar sintaxis JSON no certifica un JWT ni valores canónicos.
- 22 escenarios E01–E22 únicos; nueve etapas A–I; ocho decisiones D01–D08 con responsables/gates;
  seis estados de evidencia expresos en cada documento principal.
- Revisión cruzada con DTO/router/config/ports: body estricto, fechas, Bearer, status401/400,
  logout204, nested error solo por adaptador y app default sin montaje de auth.
- `git diff --check`: exit0 para versionados. Se comprobó también whitespace de cada archivo
  nuevo con diff no-index contra NUL y sin cambiar core.autocrlf global/local; sin incidencias.
- Los 111 archivos versionados BE conservaron su huella agregada SHA256
  `6bef3256ca415fdbcde29bfc82cf5cffa004b79a55127540facb4a59b8bc8ede`.
  Los 184 del FE conservaron
  `7605c2afeeb782da5f59bc94027c437c7d202b8733c2e6f3c44e99c95a9a985c`.
  Algoritmo: rutas de git ls-files ordenadas, por archivo ruta+NUL+SHA256 bytes+LF,
  finalmente SHA256 del agregado; mismas huellas antes/después de la edición documental.
- Verificados contra manifiestos: 11 originales históricos y sus 11 copias, 21 respaldos
  históricos y 13 copias iniciales de BE-09.3B. Informe privado BE-05 conserva su hash esperado.
- HEAD/dev/origin-dev y main/origin-main permanecen en los SHA del apartado1; FE limpio.
  Solo los seis documentos nuevos quedan sin seguimiento. No commits/push/PR/ramas/merges.
- Ningún código, configuración, dependencia, credencial o variable remota modificados. Sin
  accesos Atlas, GIS autenticado, MongoDB real, pruebas HTTP remotas ni despliegues.

No reejecutados npm ci/typecheck/build/test ni tests FE/E2E/sonda positiva. No se agregan pruebas
para aumentar conteos en una tarea documental. Los resultados históricos266/266 y13/13 no prueban
integración real ni cierran BE-09. Las aprobaciones A–I permanecen pendientes.
