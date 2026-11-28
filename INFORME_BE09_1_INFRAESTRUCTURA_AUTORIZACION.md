# BE-09.1 — Infraestructura interna de identidad y autorización

Fecha: 17/11/2026. Rama: `feature/be-09-autenticacion-analisis`.
Base/HEAD: `63c7eb20882e1e63e9ed03e2b6afa0a91e124afc`.
Estado: **implementada, auditada y validada localmente; apta para revisión y futuro
PR Draft de infraestructura**. No se publicó. BE-09 no está Done ni tiene login real.

## 1. Alcance y decisiones

Se revisaron plan, especificación, AGENTS, DoD e informes BE-05…BE-09 y su matriz.
La implementación cumple la parte independiente de proveedor: contratos, control
de procedencia de identidad/contexto, middleware por request y lectura de referencias
de propiedad ligada al cliente. No decide Google, JWT/cookies, usuarios reales,
colecciones/BSON ni un mecanismo de sesión productivo. No había un Issue BE-09
con URL/número adicional en la consigna; se siguió el alcance explícito y el plan.

El flujo futuro requiere puertos reales de servidor que todavía no existen.
Los únicos adaptadores que aceptan credenciales artificiales viven dentro del
archivo de pruebas. La app default no importa ni instancia esta infraestructura.

## 2. Archivos

| Archivo nuevo | Responsabilidad |
|---|---|
| `src/auth/contracts.ts` | Tipos nominales, estados y contratos de proveedor/identidad/pertenencia/sesión/recursos |
| `src/auth/validation.ts` | Validación runtime cerrada y aislamiento de fallos de puertos |
| `src/services/authorization.service.ts` | Verificar por puerto, resolver usuario/pertenencia y emitir capacidades privadas |
| `src/middlewares/request-authorization.middleware.ts` | Bearer explícito, estado privado y ciclo de vida por request |
| `src/repositories/client-scoped.repository.ts` | Contrato de lectura scoped, referencias de propiedad y validación de padres |
| `test/authorization.test.js` | 40 casos nuevos; todos los fakes y datos artificiales están aquí |
| Este informe y `INFORME_BE09_1_AUDITORIA_SEGURIDAD.md` | Implementación, auditoría, evidencia y limitaciones |

Se actualizaron únicamente los dos documentos BE-09.0 para distinguir su estado
histórico del alcance implementado ahora. No cambiaron app.ts, rutas/controllers/
service de health, BE-08, Mongoose, Zod de requests, package/lock, scripts, tsconfig,
.env, Vercel, frontend o IoT. No se creó un modelo Mongoose ni una colección.

## 3. Contratos y frontera de confianza

`CredentialVerifier.verify` recibe exclusivamente la credencial. Devuelve invalid
o un resultado estructurado con subject, referencia no secreta de sesión y
expiresAt (epoch en milisegundos). `source` es una opción estática de composición
del servidor, nunca un header/claim libre del request.

`IdentityResolver.resolve` recibe source/subject y devuelve usuario interno activo
o null. `SessionLifecycle.inspect` recibe source/referencia y determina estado y
expiración. Su método revoke queda definido como contrato, sin endpoint ni servicio
de logout implementado. `MembershipResolver.resolve` recibe solo UserId y devuelve
cliente activo o null. No recibe cliente elegido por el navegador.

Los outputs se validan con esquemas strict de Zod y se reconstruyen sin metadata
extra. Un resultado estructuralmente incorrecto es error interno; una excepción
del puerto se convierte en dependencia no disponible sin causa original. Los
métodos de puertos se capturan al construir la instancia para evitar reemplazo
accidental del wiring posteriormente. Sus datos dinámicos pueden cambiar para
representar sesiones/usuarios activos o revocados en un adaptador futuro.

**Estos puertos son código de servidor confiable.** Un resultado status=verified
no es prueba criptográfica por sí mismo: el adaptador real debe verificar la
credencial. La validación Zod y las marcas TypeScript no sustituyen un verificador.
Un servidor que deliberadamente configure un puerto falso puede mentir; no se
afirma proteger frente a código servidor malicioso. No hay selección por flag de
un fake ni una implementación permisiva por defecto.

## 4. Tipos y procedencia runtime

UserId, ClientId y ResourceId son claves lógicas string distintas en TypeScript.
No fijan tipos BSON. Se validan sin coerción ni trimming: no vacías, máximo 256
unidades de string y sin controles/formato invisible. Son límites internos de
infraestructura, no aprobación del DTO público o el esquema físico BE-02.

AuthenticatedIdentity contiene userId, source, authenticatedAt y expiresAt;
AuthorizationContext contiene esa identidad y clientId. No incluyen credencial,
subject externo, referencia de sesión, email, roles ni objetos del proveedor.
Los valores expuestos son congelados; no se altera el objeto del adaptador.

Las marcas nominales ayudan a compilar. La garantía runtime proviene de WeakMaps
privados de cada AuthorizationService: solo se aceptan las referencias emitidas
por esa instancia. Un JSON, spread, cast, objeto con verified=true o contexto de
otro servicio no obtiene autoridad. Una identidad autenticada no implica cliente
autorizado: resolver pertenencia es un paso separado y obligatorio.

## 5. Secuencia y errores

```text
Bearer → CredentialVerifier → SessionLifecycle.inspect → IdentityResolver
       → AuthenticatedIdentity privada → MembershipResolver
       → AuthorizationContext privada → reader ligado a scope → padres/recurso
```

El mínimo entre expiración de credencial y sesión limita la identidad. Se comprueba
antes y después de esperas relevantes. Una capacidad observada expirada o invalidada
no revive al retroceder el reloj. No se generan tokens ni se implementa refresh.

| Situación | Error interno BE-08 / traducción en fixture optativo |
|---|---|
| Credencial ausente, malformada, inválida; sesión vencida/revocada/faltante | UNAUTHENTICATED / 401 |
| Usuario local desconocido/inactivo o cliente no asignado/inactivo | FORBIDDEN / 403 |
| Contexto forjado para reader | FORBIDDEN / 403, sin consultar recursos |
| ID lógico de recurso inválido | VALIDATION_ERROR / 400 |
| Recurso ajeno/inexistente o cadena inconsistente | RESOURCE_NOT_FOUND / 404 |
| Output de puerto malformado, reloj inválido o fallo interno | INTERNAL_ERROR / 500 |
| Puerto de proveedor/identidad/sesión/pertenencia/recurso que falla | DEPENDENCY_UNAVAILABLE / 503 |

Se reutiliza el catálogo/adaptador BE-08, sin modificarlo. Los status se observaron
en apps aisladas, no son endpoints públicos aprobados. La política productiva de
login, errores/envelope y usuario sin asignación sigue dependiendo de BE-03.

## 6. Contexto por request

`createRequestAuthorization(service)` ofrece authenticate, requireClient,
getAuthenticatedIdentity, getAuthorizationContext y getState. El último distingue
unauthenticated/authenticated/authorized; no adjunta propiedades públicas a req.

El middleware solo lee Authorization estándar; rechaza ausencia, array, esquema
incorrecto, duplicación de headers y credencial fuera del formato/límite. El
esquema Bearer no distingue mayúsculas. La longitud operativa por defecto es 8192,
configurable entre 1 y 65536; debe revisarse al elegir proveedor. No lee identidad
desde body, query, req.user, req.auth o headers X-User/X-Client.

WeakMaps/WeakSets son locales a cada instancia. Cada nueva autenticación limpia e
invalida la anterior. La referencia de estado y una ejecución de autorización
impiden que resultados antiguos sobrescriban o borren un contexto reciente.
Al cerrar/terminar la respuesta se elimina estado y se invalidan capacidades,
sin revocar globalmente otras solicitudes de ese mismo usuario/sesión.

La identidad se vincula una sola vez a una función privada de liveness del request.
Los readers ya capturados también comprueban esa condición, incluso cuando
writableEnded/destroyed cambia antes de finish/close. Antes y después de una
consulta asíncrona se revalida scope. Una respuesta tardía no devuelve el recurso
si su request ya terminó. No hay usuario actual en estado global mutable.

## 7. Aislamiento multicliente

La API segura de composición es service.createScopedRepository(context, port).
Solo acepta contextos emitidos y vigentes. El helper bindClientScopedRepository
es una utilidad **interna de composición**, no un autenticador: su callback debe
proceder del validador privado del servicio; nunca construirlo desde cliente_id
del request ni importarlo como alternativa en un controller. La única llamada
actual en src está dentro del servicio de autorización.

El reader solo ofrece getField, getArea, getDevice y getMeasurement. No admite
clientId como parámetro de operación ni un filtro Mongo arbitrario. Cada llamada
al puerto incluye clientId congelado del scope y el ID/ancestros exactos.
getMeasurement valida campo → área → dispositivo → medición; un padre ajeno
detiene la lectura antes de consultar sus hijos.

El puerto debe filtrar dentro de persistencia. El fake de pruebas lo hace antes
de devolver registros y las llamadas se inspeccionan. Como defensa adicional, el
wrapper valida forma/cliente/tipo/ID/ancestros del resultado, incluso si un puerto
defectuoso devuelve un registro ajeno. Se retorna solo una referencia de propiedad
validada, no un documento ni un DTO público de negocio.

Estos nombres son una **proyección lógica**, no campos existentes de MongoDB.
No se implementaron queries, joins, populate, count o agregados reales. Una firma
TypeScript no demuestra que un futuro adapter aplique su filtro Mongo: habrá que
auditarlo y probarlo cuando BE-02 confirme catálogo/BSON/correlación. No se asigna
tenant a telemetría ambigua, ni se equipara clientid MQTT con cliente empresarial.

## 8. Simulación y composición

Todos los fakes se definen dentro de test/authorization.test.js. Simulan dos
usuarios/clientes, credenciales artificiales, usuarios/pertenencias activos o
ausentes, estados de sesión y referencias de recursos. No son verificadores reales.
No se exportan desde src ni se compilan con tsc; no hay opción de entorno que los
active. La aplicación default permanece sin esos middlewares ni rutas nuevas.

En fixtures: infraestructura BE-08 → auth.authenticate → auth.requireClient →
controller sintético → reader scoped → handler/terminal BE-08. El controller
solo presenta un ID de referencia; no consulta MongoDB ni expone el contexto.
Esto no define contratos definitivos para login/me/logout/recursos.

## 9. Pruebas y validaciones

| Ronda / comando | Resultado real |
|---|---|
| npm ci --no-audit --no-fund, reintentos/timeout acotados | 99 paquetes del lock existente, sin dependencias nuevas |
| Línea base npm test | 120/120 |
| Primera suite de infraestructura | 32/32 |
| Regressiones reloj/cierre antes del fix | Fallaron, demostrando los defectos |
| Primera suite completa ampliada | 159/160; detectó limpieza por autorización obsoleta |
| Corrección y validación completa final | **160/160**, 120 anteriores + 40 nuevas, 0 omitidas/fallos |
| npm run typecheck / npm run build | Aprobados |
| git diff --check y revisión de archivos nuevos | Aprobados |
| Diferencial contra BE-08 SHA 63c7eb2 | **13/13 equivalentes**, sin cambios HTTP nuevos |

Los 40 casos cubren autenticación/autorización distintas, procedencia runtime,
forja/copia/instancia ajena, sesiones, pertenencia, IDOR lógico, filtros obligatorios,
padres, colisiones, IDs/operadores, fallos/metadata, expiry, invalidación, headers,
concurrencia, scopes capturados, BE-08/logs, app default y tipos nominales estáticos.
Un fixture TypeScript se compila en memoria, sin crear archivo ni instalar nada.

El diferencial reconstruyó 13 módulos originales de BE-08 con git show y el
TypeScript instalado: GET, HEAD, cinco casos de Origin, wildcard, allowlist vacía,
OPTIONS, ruta 404, POST health y 500. Comparó status, body y headers CORS/seguridad;
IDs/fechas no deterministas se comprueban por forma/correlación. No confundir con
el diferencial BE-08 vs BE-07.2, que tenía dos cambios intencionales históricos.

## 10. Límites de seguridad y pendientes

- No hay verificador criptográfico real, proveedor aprobado, sesión persistente,
  login/logout/refresh productivos ni transporte cookie. No se presenta esta
  infraestructura como autenticación segura de extremo a extremo.
- Los puertos deben resolver, aplicar timeouts y cumplir su contrato. No se cancela
  automáticamente su trabajo al cerrar el request ni se impone timeout universal
  a una Promise arbitraria; se descartan capacidades/resultados tardíos.
- La revocación se simula en el puerto y se comprueba en autenticaciones nuevas.
  No se garantiza detectar un cambio del store/cliente ocurrido durante un request
  ya autenticado hasta terminar su lease; la política real requiere decisión.
- El helper interno no protege frente a código servidor que eluda deliberadamente
  la composición; tampoco un verificador falso puede volverse real por validación
  estructural. Esos adapters deberán revisarse al integrarlos.
- BE-02: catálogo usuario-cliente, BSON, unicidad, propiedad temporal y correlación
  con dispositivos/mediciones. Ninguna de esas relaciones se inventó físicamente.
- BE-03/FE: proveedor/transporte, DTO/envelope, recovery/logout/campos y bugs F09-01/02/03
  siguen abiertos. No se modificó el frontend ni se declara que sus bugs estén resueltos.
- Vercel Preview real, Atlas y pruebas de integración requieren autorización y datos
  controlados posteriores. La compatibilidad demostrada aquí es local.

## 11. BE-09.2 y recomendación

Primero cerrar proveedor y política de sesión/pertenencia. Después implementar
adapters reales y persistencia aprobada con pruebas de contrato, tiempos acotados,
validación criptográfica y scope real; componer únicamente rutas aprobadas con
FE/BE. No habilitar negocio privado sin catálogo/filtros verificados.

La infraestructura BE-09.1 está lista para revisión/auditoría y preparación futura
de un PR Draft, con los límites anteriores explícitos. **BE-09 completa no está
lista para producción ni Done.** No se inició BE-09.2.

El índice sigue vacío; no se hizo commit/push/PR/merge/deploy. HEAD y main/dev/BE-08
permanecen intactos. INFORME_BE05_VERCEL_DEPLOYMENT.md sigue sin seguimiento e intacto,
SHA256 `6445DC2925627E49F9C8EEE03BAD3DF67362761DC155DD4E9DF422A6280A5E5D`.
