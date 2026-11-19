# BE-09.2B — Implementación local de identidad Google y sesiones

Fecha de cierre local: 18/11/2026. Estado: infraestructura implementada y probada
offline; pendiente auditoría BE-09.2C, aprobación e integración real. BE-09 no Done.

## Base, alcance y preservación

Worktree `.local-consolidacion/dev`, rama `dev`, HEAD y `origin/dev` tras fetch:
`efb79c21e792e71fa14915325ed84189bd119afc`. Identidad Git local: Camila Gonzalez,
`camiiigonzalez1503@gmail.com`. Remoto: Proyecto-Agro-Org/be-agro.
No se cambió de rama ni se crearon commits, push, PR, despliegues o usuarios.
`main` conserva `1bb20f76b7a739f42c75b37b9a64315276560ec1`.

Se preservó íntegro el informe BE-09.2A y el prefijo original de 21635 bytes de su
matriz; los resultados B se agregan al final. Se verificaron por SHA256 los once
originales y sus once copias del manifiesto `../respaldos/20261117-be09/manifest.json`,
y los 21 archivos de respaldo enumerados en `../limpieza-20261117/antes.json`.
El informe BE-05 permanece fuera del seguimiento, intacto en el worktree original.
Los ocho archivos de pruebas anteriores permanecen sin cambios.

## Arquitectura y código

Se reutilizan capacidades privadas, contexto por request, repositorio con scope,
validación Zod y frontera de errores/logging de BE-08/09.1. No se creó una identidad
HTTP paralela ni se agregó un almacén de usuarios/sesiones en memoria productivo.

| Archivo nuevo | Responsabilidad |
|---|---|
| `src/adapters/google-identity.adapter.ts` | Verificación Google mediante SDK oficial, claves y claims |
| `src/config/authentication.ts` | Configuración explícita, estricta y congelada |
| `src/auth/session.contracts.ts` | Puertos de proveedor, catálogo y persistencia; semántica atómica requerida |
| `src/auth/session.schemas.ts` | Validación runtime de las salidas de los puertos |
| `src/auth/session-security.ts` | Aleatoriedad, canonicalización, digest y reloj seguro |
| `src/auth/bearer.ts` | Transporte de logout, credenciales duplicadas/malformadas |
| `src/services/session.service.ts` | Challenge, emisión, consulta, expiración, renovación y revocación |
| `src/dto/session.dto.ts` | Schemas de entrada y mapeo explícito de respuesta |
| `src/controllers/session.controller.ts` | Traducción HTTP, sin consultas ni SDK |
| `src/routes/session.routes.ts` | Composición opt-in con seguridad y admisión obligatorias |
| `test/google-identity.test.js` | Diez pruebas offline con firma RSA y SDK real |
| `test/sessions.test.js` | Treinta y seis pruebas de servicio, seguridad y HTTP aislado |

Cambios existentes: `src/auth/contracts.ts` agrega el resolver de pertenencia
vinculado a sesión; `src/services/authorization.service.ts` conserva la referencia
privada y admite exclusivamente uno de los resolvers legacy/vinculado. Se mantienen
los consumidores anteriores. También cambian `package.json`, `package-lock.json`,
`.env.example` y README. No cambian `src/app.ts`, listener, MongoDB ni contratos
OpenAPI aprobados/propuestos en otras etapas. Se crean este informe y el
[informe de auditoría](INFORME_BE09_2B_AUDITORIA_SEGURIDAD.md); se amplía la
[matriz](MATRIZ_BE09_2A_DECISIONES_Y_PRUEBAS.md).

## Adaptador Google y dependencias

Única dependencia directa agregada: **google-auth-library 11.3.4**, de runtime y
fijada exactamente. Su manifiesto declara Node >=22; se ejecutó con Node 24.19.0,
TypeScript 5.9.3, Express instalado 5.3.0, Mongoose 9.12.2 y Zod 4.6.7.
El lock agrega 21 paquetes y conserva las entradas de todos los paquetes anteriores.
No se implementa criptografía JWT de aceptación propia: el SDK verifica la firma.
Los JWT sintéticos firmados aparecen exclusivamente en tests y no son sesiones Agro.

Se restringe header a RS256/kid/typ, sin `jku` ni URL de claves recibida del token.
La verificación exige issuer Google, audience configurada, sub estable, exp/iat,
nbf y azp cuando existen, nonce asociado y email verificado si el claim email existe.
Solo se devuelve issuer canónico y sub; el email no enlaza ni aprovisiona usuarios.
El skew propio es 60 segundos por defecto, configurable entre 0 y 60 segundos;
los tests de bordes usan 0. El SDK también usa su reloj de sistema: el reloj
inyectado refuerza las comprobaciones y no sustituye el reloj interno del SDK.

La obtención real usa certificados públicos mediante el SDK con timeout 3000 ms,
sin retry automático. Se comparte únicamente la promesa concurrente de claves;
el SDK mantiene su caché pública y la promesa fallida se descarta. Un kid desconocido
se rechaza; no se fuerza una descarga por cada kid arbitrario. La rotación con
caché real queda pendiente de integración; el test usa un proveedor de claves controlado.
Errores de certificados son 503 seguros; credenciales inválidas producen invalid/401.
No se propagan errores del SDK que pueden incluir el token entero.

Fuentes: [verificación oficial GIS](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token),
[nonce GIS](https://developers.google.com/identity/gsi/web/reference/js-reference#nonce),
[repositorio indicado por el paquete](https://github.com/googleapis/google-cloud-node/tree/main/core/packages/google-auth-library-nodejs).
Ningún test llama a Google: claves efímeras generadas localmente y fetch de
certificados inyectado desde código de test. No hay selección de mocks por headers,
variables de entorno ni magic tokens.

## Challenge y emisión

GIS permite enviar el nonce al inicializar su cliente; ese mismo nonce debe estar
en el ID token firmado. El navegador deberá usar el nonce entregado por challenge;
el backend verifica su digest contra el intento persistido. La implementación FE
de ese flujo no forma parte de esta entrega.

Challenge ID, nonce, token de sesión e ID interno usan `randomBytes(32)` y base64url
canónico: 256 bits, 43 caracteres. Se persisten únicamente SHA256 del ID de challenge,
nonce y Bearer; el ID interno no es credencial. Un Bearer no contiene IDs ni perfil.
Los secretos originales no son recuperables desde el store. No se usa Math.random,
contraseña, access token Google ni JWT propio como sesión.

Flujo: buscar intento exacto por digest/realm y audience → verificar firma/nonce →
consultar usuario por issuer/sub → exigir usuario y cliente activos → reclamar
intento atómicamente y comprobar vencimiento nuevamente → crear una sesión nueva →
releer fila y comprobar vinculación inmutable completa → mapear DTO.
Dos workers con el mismo intento tienen un único ganador, según el contrato del
store. Si falla el insert posterior al claim, el intento queda consumido: se pide
otro challenge, nunca se reemite reutilizando el anterior. Una respuesta perdida
no permite recuperar el token original; pueden quedar filas huérfanas hasta expirar.

## Sesiones, persistencia y autorización

La factory requiere todos los puertos explícitos. No existe repositorio real ni
selección implícita de memoria. Las implementaciones Map están solo en el test.
Los records son contratos lógicos, **no modelos BSON ni nombres de colecciones**.

La persistencia futura debe asegurar inserciones únicas, claim condicional atómico
por digest/nonce/realm/no consumido/no vencido; lectura coherente; touch condicional
de una sesión activa; revocación durable e idempotente por digest/realm. Touch solo
puede cambiar idle y nunca borrar revokedAt o alterar vinculación/expiración absoluta.
TTL físico será limpieza, nunca autorización. Un adaptador debe tener deadlines,
cancelación y garantías de consistencia; esta entrega no simula haberlas demostrado
contra una DB real. Los puertos no tienen un timeout automático genérico.

El catálogo confiable resuelve issuer/sub → userId → clientId y securityVersion.
No hay alta JIT, roles, cliente por defecto ni uso de IDs del navegador. La sesión
queda ligada a usuario, cliente, versión y entorno. Cada nueva admisión comprueba
fila, expiración, usuario/cliente y versión; cambiar pertenencia/version invalida
la sesión anterior. El futuro catálogo debe incrementar la versión ante cambios
de seguridad que deban invalidar sesiones, incluso cambios de identidad.

BE-09.1 construye identidad y contexto privados después de verificar la sesión.
El nuevo resolver recibe la referencia concreta emitida por esa misma instancia;
un objeto copiado no adquiere capacidades. Los repositorios scoped conservan los
filtros por cliente y las relaciones de jerarquía; se prueba A/B y recurso ajeno 404.

Defaults propuestos: challenge 5 min, absoluta 8 h, idle 30 min. Límites: challenge
1 s–10 min, absoluta 1 s–24 h, idle 1 s–1 h y nunca mayor a absoluta. Actividad válida
extiende idle hasta el máximo absoluto; no revive una sesión ya expirada/revocada.
`AUTH_ENVIRONMENT`, `GOOGLE_CLIENT_ID`, `AUTH_ALLOWED_ORIGINS` son obligatorios al
construir configuración. Los tres `AUTH_*_MS` de `.env.example` se validan como
enteros decimales dentro de límites; ausente usa default, vacío/malformado rechaza.
El placeholder de Client ID es deliberadamente inválido hasta configurarlo.

Logout no requiere pertenencia activa y revoca solo la sesión aportada. Ausente o
token canónico desconocido es idempotente; el transporte malformado/duplicado se
rechaza. Una falla del store responde 503, sin afirmar que revocó. Nuevas admisiones
en otro worker ven la revocación si el store cumple su coherencia. Una capacidad
ya admitida puede completar operaciones en curso hasta su lease/expiración: no se
promete cancelación remota instantánea. La consulta current vuelve a comprobar fila
y catálogo. Requiere relojes sincronizados; no se certifica tolerancia a rollback
del reloj de todos los workers.

## HTTP preparado, sin activar

Montaje usado **solo en apps Express de test**: `/api/v1/auth`.

| Método/ruta relativa | Entrada | Respuesta propuesta |
|---|---|---|
| POST `/google/challenge` | JSON `{}`; sin query/params | 200 challenge_id, nonce, expires_at ISO UTC |
| POST `/login` | provider google, credential y challenge_id; schema estricto | 200 token, token_type Bearer, usuario, cliente, sesion |
| GET `/session` | Sin body/query/params; Authorization | 200 usuario, cliente, sesion; sin token |
| POST `/logout` | Sin body/query/params; Authorization opcional | 204 sin cuerpo tras revocación confirmada |

Sin entrada de DTO para sesión/logout: Bearer pertenece al transporte. Las respuestas
se mapean explícitamente desde el catálogo, sin documentos Mongoose, digest, sub,
securityVersion ni datos del SDK. Rutas/nombres/estados son propuestas para BE-03,
no contratos de frontend aprobados. No se actualizaron OpenAPI ni endpoints default.

Se exige una sola infraestructura BE-08 con contexto/logging/headers/errores; el
test usa `{error:{code,message}}`. La factory de router obliga a inyectar admisión
compartida: false →429, falla →503. No existe limiter productivo por defecto.
El puerto limita por operación; políticas por usuario/IP fiable, cuotas y deadlines
deben diseñarse antes de activar. El parser es el de BE-08 (16 KiB), con schemas
estrictos y credential <=8192 caracteres. Rechazos 400/413/415 sanitizados.

Todos los responses del router llevan no-store. CORS usa lista exacta sin wildcard
ni credentials; origins HTTPS salvo localhost HTTP en test/development. Todo POST
requiere Origin permitido; GET sin Origin es posible con Bearer. El preflight reutiliza
los métodos generales de CORS legacy, sin crear handlers para métodos no declarados.
Bearer solo en Authorization, nunca query; múltiples headers reales o credenciales
combinadas se rechazan. 401 = sesión inválida/ausente; 403 = principal sin usuario o
cliente autorizado; fallos de dependencias 503. Errores públicos no incluyen entradas.
Los módulos nuevos no escriben logs; BE-08 emite su DTO cerrado con request ID.

## Validaciones reales

| Verificación | Resultado |
|---|---|
| `git fetch origin` | Correcto; origin/dev conserva efb79c2 |
| `npm ci --no-audit --no-fund` | Correcto, 120 paquetes; warning transitorio node-domexception 1.0.0 deprecado |
| `npm run typecheck` | Exit 0, strict/NodeNext |
| `npm run build` | Exit 0 |
| `npm test` | **206/206**, 160 previas + 46 nuevas; 0 fallos/skip/canceladas |
| `git diff --check` | Exit 0; sin errores de whitespace |
| Comparación HTTP contra efb79c2 | **13/13 equivalentes**, cero cambios intencionales nuevos |
| `npm audit --omit=dev --json` | Exit 0; cero vulnerabilidades conocidas reportadas |
| Lock anterior / `npm ls --depth=0` | Entradas anteriores intactas; dependencias coherentes |
| Inspección AST/imports | Sin tipos any; sin ciclos estáticos; auth no alcanzable desde app.ts |
| Archivos excluidos | Sin .env, dist, node_modules ni documentacion-referencia en candidatos |

La comparación cargó 13 módulos de la base mediante transpile en memoria y comparó
status, cuerpo y headers con dist actual en puertos loopback: health GET/HEAD,
origen permitido/denegado/slash/subdominio, wildcard, lista vacía con/sin Origin,
OPTIONS, ruta desconocida, POST health y error 500. Los dos 404 endurecidos de BE-08
ya pertenecen a la base y permanecen iguales. No se realizaron pruebas remotas.

## Riesgos, compatibilidad y próximos pasos

El Bearer legible por JS puede ser robado por XSS; hash del store no lo evita.
sessionStorage, CSP, dependencias FE y ciclo de vida del token requieren revisión.
Permanecen los tres problemas FE identificados en A: 401 viejo que limpia sesión
nueva, storage fallido sin fallback compartido y parser de errores anidados.
La API aislada funciona en tests; **no demuestra compatibilidad FE real**.

Pendientes bloqueantes para habilitar: BE-02/catálogo/BSON y persistencia durable,
aprobación FE/BE y BE-03 de rutas/DTO/errores/TTL; proyecto GIS y Client IDs/origins
por entorno; limiter distribuido, deadlines, índices/retención y pruebas de consistencia.
Después: prueba end-to-end con cuentas de prueba autorizadas, dos clientes y DB
aislada; Preview Vercel explícitamente autorizado para comprobar variables, TLS,
orígenes, reloj, cold starts, red de claves y concurrencia. No se accedió a Atlas ni
se modificó Vercel. No hay autenticación productiva habilitada ni BE-10 iniciado.

Lista para auditoría local BE-09.2C; no lista para activar login productivo o cerrar BE-09.

## Actualización posterior BE-09.2C — 18/11/2026

La auditoría C reprodujo y corrigió dos defectos medios: el SDK sobrescribía el
default sin retries al descargar claves y el control exacto de idle rechazaba
renovaciones concurrentes correctas. Ahora el cliente privado impone la política
después del merge (retry=false y retryConfig.retry=0) y touch exige un max atómico
sin retroceder idle, dentro del límite absoluto y del límite temporal vigente.
La exigencia histórica de idle exactamente solicitado queda sustituida por esta
política; no se permite cambiar otros campos del binding.

C01/C03/C04 prueban SDK/Gaxios reales con fetch offline: opciones efectivas, 503
con un intento, recovery y rotación/caché con reloj simulado. La afirmación anterior
sobre ausencia de retries se considera intención de B, corregida y demostrada en C.
La red/configuración GIS reales siguen pendientes. C14 documenta que HTTP abortado
no deshace un insert: puede dejar una sesión huérfana hasta expirar, sin entregar
ni recuperar su secreto o reutilizar el challenge.

Estado actual: **220/220 pruebas**, 206 anteriores más 14 C; npm ci, typecheck,
build y diff-check correctos; 13/13 HTTP equivalentes. Sin dependencias nuevas C,
sin activación productiva y sin commit/push/PR/deploy. Detalle, límites diagnósticos
y gates en [auditoría C](INFORME_BE09_2C_AUDITORIA_FINAL.md) y
[trazabilidad C](MATRIZ_BE09_2C_TRAZABILIDAD.md). Apta para revisión/integración
como infraestructura deshabilitada; BE-09 continúa parcial.
