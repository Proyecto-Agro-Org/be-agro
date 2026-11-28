# BE-09.2C — Auditoría final local de autenticación y sesiones

Fecha: 18/11/2026. Repositorio Proyecto-Agro-Org/be-agro. Worktree
`C:\Users\CamilaGonzález\be-agro\.local-consolidacion\dev`, rama `dev`.
Base/HEAD: `efb79c21e792e71fa14915325ed84189bd119afc`.

## 1. Resumen ejecutivo

Auditoría local completada. Se reprodujeron y corrigieron **dos defectos de
severidad media**, relacionados con disponibilidad y garantías de concurrencia.
Las regresiones nuevas fallaron antes de corregir el código y aprobaron después.
Resultado final: **220/220 pruebas**, incluidas las 206 de entrada; 14 pruebas
nuevas, typecheck y build correctos; **13/13 escenarios HTTP equivalentes**.

No se identifican hallazgos altos/críticos abiertos en el alcance local revisado.
Esto no certifica seguridad productiva ni satisface dependencias externas. Se
recomienda revisar e integrar únicamente la infraestructura **deshabilitada por
defecto**, mediante el procedimiento Git autorizado posteriormente. No se realizó
commit, push, PR, merge, deploy, conexión Atlas ni activación de autenticación.
BE-09 permanece parcial y no se inició BE-10.

## 2. Preparación, evidencia inicial y preservación

Al inicio se verificaron rama, remoto HTTPS universitario, identidad Git local
Camila Gonzalez / camiiigonzalez1503@gmail.com, HEAD y los 22 archivos candidatos
de B: seis modificados versionados y dieciséis sin seguimiento. No se descartaron
archivos ni se cambió de rama. El índice permanece vacío. Los cambios de B no
están comprometidos: las diferencias C se evalúan también contra su estado local
inicial, no solamente contra HEAD BE-09.1.

Se registró manifiesto SHA256/tamaños de esos 22 archivos antes de editar C.
Informe A íntegro; matriz A/B e informes B conservan sus bytes iniciales y reciben
anexos fechados. Se verificaron los once originales y once copias del manifiesto
histórico y los 21 archivos de respaldo de la limpieza anterior. El informe local
BE-05 permanece intacto y excluido en el worktree original. `documentacion-referencia/`,
`.env`, `node_modules` y `dist` no son candidatos a publicación. No se alteraron
credenciales ni configuraciones de otros proyectos.

`main` y `origin/main` conservan `1bb20f76b7a739f42c75b37b9a64315276560ec1`;
`dev`, HEAD y `origin/dev` conservan efb79c2. Se consultaron referencias locales,
sin realizar operaciones de publicación. Evidencias auxiliares regenerables quedan
en `node_modules/.cache/be09-2c/`, ignorado: manifiesto inicial, log de suite,
comparación HTTP y resumen de preservación. No son respaldo durable ni secretos.

## 3. Arquitectura auditada

Se revisaron los diez módulos nuevos B, los contratos y servicio BE-09.1,
middleware de autorización por request, validación Zod, frontera de errores y
observabilidad BE-08, CORS, configuración, app/listener, infraestructura Mongoose,
dependencias/lock y documentación A/B/plan/especificación/DoD.

Flujo: adaptador Google → principal issuer/sub → catálogo confiable → usuario y
cliente activos → sesión opaca → BE-09.1 identidad privada → pertenencia ligada a
la sesión → contexto privado → repositorio con scope. Controllers no consultan
MongoDB ni instancian SDK. Service no depende de Express. No existen modelos
productivos nuevos ni repositorios de sesiones en memoria en src. Los Map y
verificadores falsos están en tests; no hay selector mock por headers o entorno.

`src/app.ts`, listener, MongoDB, Vercel y las ocho suites anteriores a B no se
modificaron. El router de sesiones sigue fuera del grafo de imports de app.ts.
Se verifican AST sin tipos any y grafo estático sin ciclos; esto no sustituye una
prueba de todas las composiciones futuras. Los comentarios históricos del plan
no se convierten en aprobaciones nuevas ni se marcan casillas Done.

## 4. Hallazgos reproducidos y correcciones

| ID | Severidad | Causa y efecto | Corrección y prueba |
|---|---|---|---|
| C-F01 | Media | El SDK agrega `retry:true` por request y sobrescribe el default `retry:false` del transporter. Además Gaxios considera retryConfig aunque el flag sea false. El informe B afirmaba ausencia de reintentos sin comprobar la opción efectiva: fallos de claves podían multiplicar requests/latencia | Interceptor del cliente privado después del merge: retry=false, retryConfig.retry=0, noResponseRetries=0 y totalTimeout=3000. C01 observó retry=true antes; ahora observa false/0 y timeout=3000. C03 confirma un único fetch en 503 y recuperación |
| C-F02 | Media | Touch exigía idle exactamente igual al solicitado. Una renovación antigua que termina después de otra nueva rechazaba un adaptador correcto con max atómico; asignar el candidato sin max podía reducir la vigencia recién extendida | Contrato explícito max(current idle, requested idle), acotado por absoluta. Servicio admite un resultado no menor al snapshot/candidato y no mayor a min(absoluta, ahora+idleTTL), con binding inmutable. C02, barreras y avance de reloj, falló antes y aprueba después |

C-F02 actualiza también el doble de persistencia para cumplir el contrato; no se
rebajó ninguna expectativa anterior. No existe adaptador DB real al que se haya
aplicado una migración. El control presupone reloj confiable/sincronizado; no
autoriza extensiones arbitrarias ni elimina la revocación.

Los hallazgos B-F01 y B-F02 previos siguen cubiertos por sus regresiones: vencimiento
durante claim y sustitución de binding en relectura. No se reabrieron.

## 5. Google Identity: comprobaciones y límites

El SDK oficial 11.3.4 ejecuta la verificación criptográfica RS256 con claves
públicas; se exige issuer Google, audience fija, sub válido, exp/iat, nbf/azp cuando
existen, nonce del intento y email_verified si existe email. No se enlaza por email
ni se admite un objeto perfil como prueba. Audience/clave/fetch no proceden del
request. Access token Google no es sesión Agro; el segundo solo acepta un opaco
canónico que resuelva una fila válida.

El nonce se entrega al frontend para `google.accounts.id.initialize({nonce,...})`;
GIS lo incluye en el ID token firmado y el backend compara su SHA256 con el intento
persistido. No basta un nonce libre en JSON. El flujo seleccionado usa callback
JS y envío JSON con Origin validado, no recepción directa form_post GIS. Si se
adoptara form_post deberá diseñarse su validación CSRF correspondiente; no está
implementado ni habilitado aquí. [Referencia GIS nonce](https://developers.google.com/identity/gsi/web/reference/js-reference#nonce),
[guía de verificación](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token).

El skew propio sigue acotado a 0–60 segundos, default 60; las pruebas de borde usan
0. SDK también consulta el reloj de sistema; no se afirma que inyectar now cambie
ese reloj. No se usa nombre/email mutable como identificador. C10 prueba dos
principales distintos con idéntico email sin mezclar sus clientes.

C01/C03/C04 recorren el SDK **y Gaxios reales** con un fetch exclusivamente local
inyectado desde test: opciones efectivas, 503 sin retries, caché max-age y rotación
después de expirar mediante reloj simulado. Kid ajeno durante caché no provoca
descargas arbitrarias. Se descarta la promesa fallida y una llamada posterior
recupera. No hay llamadas de certificados a Google durante la suite ni se prueba
la configuración GIS real, red, TLS o aceptación de cuentas reales.

## 6. Challenge y fallos parciales

Se mantiene aleatoriedad crypto de 32 bytes para ID/nonce, TTL corto validado,
digest y realm/audience, recheck tras awaits y claim atómico por intento. La carrera
de dos workers sobre un intento tiene un ganador en el store de pruebas.
C09 verifica múltiples challenges y sesiones concurrentes independientes; el
muestreo de unicidad no pretende demostrar matemáticamente la ausencia de colisiones.

C05 simula pérdida de confirmación **después** de consumir: devuelve 503, el retry
del mismo intento falla y otro challenge permite recuperar. Insert fallido posterior
al claim tampoco vuelve a habilitarlo. No se implementa retry ciego ni rollback
del consumo. Estas garantías requieren atomicidad y coherencia del adaptador real;
un puerto que incumpla el contrato no queda certificado por sus tipos TypeScript.

## 7. Sesiones, pertenencia y revocación

Tokens de 256 bits, base64url canónico; solo SHA256 persistido. No contienen perfil,
userId/clientId ni JWT propio. Se mantienen absoluta, idle, no-store, logout durable
idempotente por digest/realm y rechazo de filas vencidas aunque el TTL físico no
las haya limpiado. Nuevas solicitudes no autentican con sesión revocada.

La pertenencia se fija al emitir y se **revalida posteriormente**: usuario, cliente
y securityVersion deben coincidir con la sesión. No se traslada una sesión vieja
al nuevo cliente. Un cambio requiere invalidación/versionado confiable en catálogo;
no se implementan roles. A/B concurrentes y scopes de jerarquía ajena conservan el
rechazo 404 sin consultar recursos fuera del scope requerido.

La política de revocación es de admisión/snapshots: una operación ya admitida puede
terminar después del logout; no hay cancelación distribuida de I/O. C13 prueba
logout entre authenticate y authorize: la nueva autorización falla e invalida la
capacidad. C08 prueba expiración durante pertenencia: no entrega contexto y la
capacidad no revive al atrasar el reloj de test. Una lectura iniciada antes del
cambio puede observar un snapshot anterior; no se promete linealización atómica
entre catálogo y store ni revocación instantánea en todos los awaits.

## 8. Concurrencia, abort y resultados obsoletos

C06 cierra el request mientras verifica la sesión; la identidad tardía no revive.
C07 completa B antes que A sobre la misma instancia Request: el resultado viejo
no borra ni sustituye el contexto B. Se conservan las regresiones BE-09.1 de leases,
generaciones y cierre, junto con las de logout/touch de B.

C14 usa HTTP loopback y AbortController: el cliente aborta después del claim y
mientras espera el insert. Se observa close mediante el logger y se liberan
promesas con barreras, sin sleeps temporizados. No se entrega token, el intento
queda consumido y puede persistirse una fila huérfana sin secreto recuperable.
Su limpieza/retención deberá implementarse con el store. Cancelar la conexión
HTTP no implica deshacer una escritura confirmada ni prueba una transacción DB.

## 9. Transporte, errores y logging

Bearer solo desde Authorization; se conservan rechazos de duplicados reales,
credenciales combinadas, tamaños y tokens malformados. Query/body no autentican.
C11 prueba que cookies y headers públicos con usuario/cliente B no reemplazan
Authorization A; no elevan scope. Logout no procesa tokens desde body.

CORS de auth: origen exacto, sin wildcard ni credentials; POST requiere Origin
permitido; GET puede omitirlo con Bearer. Sin Origin no se crea sesión. Configuración
obligatoria inválida falla cerrada al construir los componentes, sin impedir health.
Admisión explícita requerida por el router; no hay limiter in-memory productivo.

C12 inyecta string, objeto, Error con causa y Proxy hostil desde un puerto. Respuesta
503 y log cerrado no contienen token, nonce, ID de challenge, cookies, URI, cuerpo,
excepción ni datos del cliente ajeno. No se envían excepciones originales a sinks.
DTO de login entrega intencionalmente el token al cliente autorizado; GET session
no lo devuelve. Los errores del SDK que pueden contener JWT son descartados.

Clasificación documentada: errores de I/O desconocidos se normalizan a 503; salida
inválida comprobada fuera de un puerto genera 500. Si una validación interna del
adaptador de sesión lanza dentro de un puerto BE-09.1, su frontera callPort también
la normaliza a 503. No se afirma que toda salida inválida profunda produzca 500.
Es una limitación diagnóstica segura; no se relajó la sanitización global para
propagar excepciones de adaptadores arbitrarios.

## 10. Dependencias y compatibilidad

Sin dependencias nuevas ni actualizaciones C. SDK 11.3.4, engines >=22, ejecutado
con Node 24.19.0, TypeScript 5.9.3, Express instalado 5.3.0, Mongoose 9.12.2 y Zod
4.6.7. Se revisaron fuente instalada del SDK, AuthClient.RETRY_CONFIG, Gaxios 8.3.3
y su merge/interceptores/retry. Fuente del paquete:
[monorepo oficial](https://github.com/googleapis/google-cloud-node/tree/main/core/packages/google-auth-library-nodejs).

`npm ci` reproducible en ambas rondas; package.json/lock idénticos a B.
`npm ls --depth=0` coherente. `npm audit --json` completo, incluyendo desarrollo:
exit 0, cero avisos conocidos al consultar el registro. No demuestra ausencia de
vulnerabilidades. Se conserva warning transitivo deprecado node-domexception 1.0.0;
no se actualizan paquetes de otras etapas por ese warning.

Se preservan ESM NodeNext, Express default export, health, CORS legacy, errores y
logging BE-08, Zod, manager Mongoose sin conexión automática y separación app/listener.
No se modifica vercel.json. Compatibilidad local verificada; Preview/cold starts y
red efectiva requieren despliegue autorizado y no se declaran probados.

## 11. Comandos y resultados

| Ronda / comprobación | Resultado |
|---|---|
| Inicial: npm ci, typecheck, build, npm test | Exit 0; **206/206** antes de cambios C |
| Reproducción C01/C02 | Dos tests fallidos: retry=true y renovación atómica rechazada |
| Corrección y ejecución específica C01/C02 | **2/2** aprobadas |
| Ampliación C03…C14 | Nuevas pruebas aprobadas; sin red ni sleeps de carrera |
| Final: npm ci --no-audit --no-fund | Exit 0; 120 paquetes instalados, warning registrado |
| Final: npm run typecheck | Exit 0 |
| Final: npm run build | Exit 0 |
| Final: npm test | **220/220**, cero fallos, skipped o canceladas |
| git diff --check y whitespace de archivos nuevos | Sin errores; avisos normales de conversión LF/CRLF no son fallos |
| Comparación HTTP contra efb79c2 | **13/13 equivalentes**, cero cambios inesperados |
| npm audit --json | Cero vulnerabilidades conocidas reportadas |

Comparación: módulos de HEAD transpileados en memoria vs dist local, requests
loopback; status, cuerpo y headers contractuales de health GET/HEAD, allowed Origin,
denied Origin, slash, subdominio, wildcard, allowlist vacía con/sin Origin, OPTIONS,
ruta desconocida, POST health y error 500. Los dos 404 endurecidos ya están en la
base, sin nuevas diferencias. No es prueba contra Vercel.

Las pruebas nuevas, nombres y cobertura por requisito se registran en la
[matriz de trazabilidad C](MATRIZ_BE09_2C_TRAZABILIDAD.md).

## 12. Archivos de esta auditoría respecto del estado local B

Modificados: `src/adapters/google-identity.adapter.ts`,
`src/services/session.service.ts`, `src/auth/session.contracts.ts`,
`test/google-identity.test.js`, `test/sessions.test.js`, README,
los dos informes B y la matriz A. No se cambió implementación BE-09.1 en C.
Nuevos: este informe y `MATRIZ_BE09_2C_TRAZABILIDAD.md`.
Todos los archivos B continúan locales/sin commit; su estado untracked no implica
que hayan sido creados por C. Índice vacío; ninguna ref de rama fue modificada.

## 13. Riesgos externos y gates de habilitación

1. BE-02: aprobar catálogo/principal/cliente, BSON y adaptadores compartidos, índices
   únicos, TTL/retención, max atómico de idle, claim, revocación, consistencia y
   deadlines. Probarlos con DB aislada; no hay acceso Atlas ni modelos definitivos.
2. GIS: Client IDs y origins por entorno; callback/nonce real y pruebas con cuentas
   autorizadas. Cada realm debe usar almacén/namespace aislado según despliegue;
   no compartir indiscriminadamente el realm production entre aplicaciones o
   topologías Preview independientes. Aquí realm solo distingue cuatro entornos,
   no genera un identificador único por branch/deployment/OAuth client.
3. FE/BE-03: aprobar rutas/DTO/errores/TTL/skew y sesiones múltiples. Las cuatro
   operaciones siguen propuestas y no montadas. Resolver tres defectos FE de A:
   401 viejo, storage fallido y parser de errores anidados. No se modificó frontend.
4. XSS: sessionStorage/Bearer permanece accesible a JS; hash en DB no protege un
   token robado en cliente. Requiere CSP del frontend, higiene de dependencias,
   manejo seguro de DOM y generaciones de sesión. No afirmar inmunidad XSS.
5. Admisión y operación: limiter distribuido/quotas por dimensiones confiables,
   deadlines/cancelación de puertos, presupuesto total de login y pruebas de carga.
   Un timeout de claves no es un deadline de todo login. Sin fallback de memoria.
6. Vercel/E2E: Preview y entornos aislados autorizados, SHA y variables efectivos,
   TLS, red de claves, reloj, cold starts y dos clientes. No se revisaron settings
   remotos ni se autorizaron cambios en Production en esta tarea.

Recomendación final: **apta para revisión e integración en dev como infraestructura
inactiva**, conservando estos gates. No apta para habilitar login productivo ni
cerrar BE-09. No hay hallazgos altos/críticos locales sin resolver; las dependencias
de producto y operación continúan abiertas y no se consideran completas.
