# BE-08.3 / BE-08.4 / BE-08.5 — Hardening y evaluación final local

Fecha: 17/11/2026. Resultado: **BE-08 apta técnicamente para publicación Draft: SÍ**,
con validaciones locales aprobadas y sin hallazgos altos/críticos conocidos abiertos
dentro del alcance auditado. No equivale a Done, aprobación de contratos FE/BE,
integración ni validación remota. No se hizo commit, push, PR ni despliegue.

## 1. Estado inicial, alcance e inventario

Rama conservada: `feature/be-08-errores-logging-seguridad`.
HEAD/base: `04cf46155ca179a80127cfdda56ccbb0a59947c9` de BE-07.2.
Remoto: `https://github.com/Proyecto-Agro-Org/be-agro.git`.
Identidad local: Camila Gonzalez, `camiiigonzalez1503@gmail.com`.
No se consultaron GitHub, Vercel ni Atlas ni se cambiaron credenciales. La única
operación de dependencias fue npm ci autorizado con el lock existente.

BE-08.2 comenzó con 102 pruebas aprobadas, logging raw default y 404 reflectante
abiertos. Las dos expectativas de identidad del Error eran una restricción de la
auditoría anterior; la consigna actual autorizó expresamente revisarlas conservando
su intención. Esos bloqueos se resolvieron, sin mutar el error del consumidor.

Se inspeccionaron los 21 módulos TypeScript finales de src/scripts, app y listener,
rutas/controllers/service/DTO health, CORS, errores, observabilidad, validación Zod,
configuración y manager MongoDB, package/lock, tsconfig, Vercel, pruebas y README.
Se contrastaron plan, especificación, AGENTS, DoD e informes BE-05 a BE-08.
No hay repositorios/modelos de negocio ni autenticación implementados.

| Componente | Default actual | Optativo actual |
|---|---|---|
| Contexto UUID servidor | Activo; header X-Request-ID | Activo; mismo principio |
| Logs de inicio/final | No añadidos globalmente | Activos |
| Logs de error | Proyección segura a console.error para 5xx | Proyección segura al sink para errores traducidos |
| Health route → controller → service → DTO | Activo, sin persistencia | Igual |
| CORS | Política exacta existente | Igual política |
| Parser JSON/límite | No agregado globalmente | Estricto, 16 KiB configurable |
| 404 | HTML constante genérico | JSON con mensaje fijo |
| Headers nuevos | 404: nosniff/no-store/CSP; x-powered-by deshabilitado globalmente | nosniff/no-referrer/no-store/CSP en todos sus caminos |
| Error handler y frontera terminal | Activos | Activos |
| MongoDB | Solo conexión explícita futura; no se llama | Igual |

### Flujo y rutas alternativas

```text
Request → contexto UUID → [headers optativos] → CORS → [parser optativo]
        → route/etiqueta estática → [Zod en fixture/operación futura]
        → controller → service → DTOResponse

Error de middleware/parser/Zod/route/service
        → clasificador/handler → proyección cerrada al logger → respuesta fija/adaptador
Ruta no registrada → 404 genérico
Headers enviados → error nuevo seguro → frontera terminal → cierre sin Error original
Conexión cerrada → no nueva escritura; finish/close se registra una sola vez si corresponde
Framing HTTP inválido → transporte Node; puede responder 400 o cerrar antes de Express
```

La app real solo registra health. Las rutas de fallo, validación y concurrencia
pertenecen a aplicaciones aisladas de pruebas. No se creó un endpoint para probar
seguridad ni se conectó MongoDB al pipeline HTTP.

## 2. Hallazgos, evidencia, alternativas y correcciones

| Hallazgo | Severidad local | Evidencia / causa | Solución y alternativa descartada | Resultado |
|---|---|---|---|---|
| H01: logging raw legacy | Alta | console.error recibía Error con message/cause/propiedades sensibles | DTO de allowlist; no regex de redacción ni mutación del Error | Cerrado; sink no recibe referencias ni secretos |
| H05: pathname en 404 | Media | finalhandler incluía pathname escapado en HTML | HTML constante; se descartó imponer globalmente el JSON propuesto BE-03 | Cerrado; 404/HTML se conservan sin reflejo |
| H08: coerción de etiquetas | Media | regex aceptaba objeto con toString válido y se almacenaba el objeto completo | Exigir string primitivo antes de validar identificador; no sanitizar un objeto arbitrario | Cerrado; prueba inicialmente falló y luego aprobó |
| H09: status/code no primitivos al logger | Media | llamada JS a logError podía entregar un objeto en status/code aunque TS lo restringiera | Guardas runtime de número entero y catálogo de códigos; construcción explícita de campos | Cerrado; prueba inicialmente detectó marcador en sink |
| H10: promesa descartada por wrappers de consola | Media | callback con bloque no devolvía Promise de una consola instrumentada; el rechazo escapaba | Devolver el resultado al emisor que aísla sync/async; no ocultar fallo cambiando la prueba | Cerrado; prueba anterior detectó el fallo durante la ronda de corrección |
| H11: salida al finalhandler tras headers | Media | next(error seguro) podía dejar a Express registrar un stack fuera del esquema de logs | Frontera terminal propia; conserva delegación interna, termina sin Error en destroy | Cerrado en composiciones incluidas; prueba HTTP real en ambos modos |
| H12: coerción innecesaria del tipo de error parser | Baja | String(type) podía ejecutar conversión personalizada en un objeto desconocido | Comparaciones estrictas de strings conocidos, sin conversión | Cerrado; prueba de no ejecución |
| H13: múltiples next(error) tardíos agotan los middlewares | Alta | Una regresión posterior encontró Error original en console.error de Express tras llamadas encadenadas | Callback final de dispatch propio; no silenciar globalmente console ni configurar env=test | Cerrado en ambos perfiles; regresión negativa y prueba de callback externo |

H02/H03/H04 de BE-08.2 (status inválido, fallos del logger, carreras de headers)
se conservaron y volvieron a comprobarse. No se restauró logging inseguro para
pasar tests. Las cuatro regresiones iniciales del nuevo archivo fallaron contra
la implementación anterior y aprobaron después de corregirla; no son hallazgos
inventados a partir de tests verdes. Las pruebas adicionales amplían cobertura,
sin atribuir cada caso nuevo a un defecto encontrado.

### Pruebas históricas revisadas

`test/health.test.js` y `test/health-layers.test.js` verificaban HTTP 500 seguro,
una llamada al logger y referencia idéntica del Error. Se conservaron status,
body, propagación async y una llamada; la expectativa de identidad se sustituyó
por JSON estructurado con event/status/errorCode e ID correlacionado, sin mensaje
original. La modificación es un cambio explícito de seguridad del contrato interno
de logging, no un ajuste del contrato HTTP para ocultar una regresión.

En `test/http-infrastructure.test.js` se completó un Response simulado con setHeader
y se montó la frontera terminal en el fixture. No se eliminaron pruebas ni se
relajaron expectativas HTTP de las 102 existentes.

## 3. Arquitectura y contrato final de logging

`createRequestObservability` mantiene contexto por Request en WeakMap. El emisor
entrega al sink un objeto nuevo congelado, construido únicamente con primitivos
permitidos. No recibe un Error para serializar ni copia propiedades de objetos
ajenos. Las guardas runtime complementan los tipos RequestLog/LogSink:

- timestamp ISO generado internamente, event de unión cerrada y UUID generado;
- método dentro de lista fija, o OTHER;
- route configurada como identificador estático primitivo; default unmatched;
- status entero dentro del rango correspondiente, fallback seguro 500;
- errorCode perteneciente al catálogo cerrado, fallback INTERNAL_ERROR;
- duración monotónica y outcome finished/aborted cuando se instrumenta el ciclo.

Ni los sinks inyectables ni console.error/info reciben objetos Error, Request,
Response, cause, stack, Authorization, Cookie, URI, cuerpo, query, pathname o
campos extra. Se usaron cinco marcadores artificiales distintos y excepciones con
cause anidada/propiedad no enumerable. Los tests inspeccionan los argumentos reales
del callback y consola, incluyendo propiedades ocultas, no solo el JSON HTTP.

El Error original permanece sin modificar. Un consumidor externo puede inspeccionar
todos los campos del DTO y no encontrará referencias a objetos originales. La
inmutabilidad es suficiente para este DTO porque todos sus valores son primitivos.
Los nombres de campos públicos no implican autorización para incluir valores
provenientes de usuarios; la etiqueta debe ser constante del desarrollador.

Default: contexto ligero sin logs globales de inicio/final, error 5xx mediante
console.error(JSON.stringify(dto)). Optativo: eventos start/finish/error y sink
default console.info(JSON.stringify(dto)). Los wrappers devuelven su resultado
al emisor para que capture rechazos si la consola se instrumenta de forma async.
Un sink lento no bloquea la respuesta; fallos se descartan sin registrar su causa.
Es best effort: no se garantiza persistencia ni flush serverless, ni retención,
control de acceso o entrega durable. No se afirma que estas pruebas certifiquen
el logging de Node/Vercel u otro código externo al pipeline propio.

## 4. Errores HTTP y ciclo de vida

Se mantienen las categorías internas: validación 400, no autenticado 401,
prohibido/CORS 403, inexistente 404, conflicto 409, payload 413, media type 415,
límite representado 429, interno 500 y dependencia declarada 503. Representar
401/429 no implementa autenticación ni rate limiting. Las excepciones MongoDB
no se clasifican inspeccionando mensajes; el consumidor debe traducir una
dependencia conocida, y las desconocidas quedan en 500 seguro.

Perfil optativo: Zod esperado → 400; refinamiento que arroja/rechaza → 500.
Body/params/query, transformaciones, coerciones, concurrencia y resultados obsoletos
se verificaron con BE-07.2 sin modificar su implementación. El accessor sigue
siendo necesario para consumir salida validada; parsear JSON no valida un DTO.

String arrojado, objeto arbitrario, mensaje/cause/stack con marcadores, propiedades
inesperadas y getters hostiles producen respuestas controladas sin diagnóstico.
Status legacy inválido, null, NaN, Infinity y status de éxito ante error quedan en
500. El envelope transitorio error:string se conserva, sin aprobar unilateralmente
el futuro error:{code,message}. El adaptador solo recibe descriptor seguro e ID.

Después de headers se delega un error nuevo sin causa original. La frontera terminal
lo consume: si el stream está abierto lo destruye sin argumento; si terminó o fue
destruido no escribe. Antes de headers su fallback es 500 JSON fijo. La auditoría
posterior demostró que varias llamadas tardías a next(error) podían agotar incluso
esa frontera y alcanzar el logger raw de Express. protectApplication instala
también un callback final propio en app.handle, que proyecta diagnósticos y termina
con seguridad aun cuando se agota el stack. Conserva el dispatch original y el
objeto Express. Un callback de embedding recibe solo un Error nuevo fijo, nunca el
original; el padre debe proteger sus propios sinks.

Se comprueba que handle sea función antes de la única aserción de integración:
Application no lo declara en sus tipos. Esta dependencia del dispatch Express 5.3.0
inspeccionado exige repetir regresiones al actualizarlo y comprobar Preview.
No se parchea console globalmente ni se fuerza NODE_ENV=test para ocultar logs.
Consumidores aislados deben instalar protectApplication y la frontera terminal,
como los fixtures/createApp. No se promete recuperar un stream parcial.

Dos handlers que resuelven concurrentemente sobre el mismo Response no escriben
dos veces; se vuelve a comprobar estado después del adaptador async. Un error
tardío tras abortar no reabre la respuesta. Un adaptador personalizado es código
confiable y debe terminar: no se incorporó timeout para promesas arbitrarias del
servidor. Los adaptadores actuales no hacen I/O externo.

## 5. Request ID, headers, CORS y límites

UUID v4 mediante crypto.randomUUID por solicitud en ambos modos; nunca se adopta
X-Request-ID/X-Correlation-ID del cliente ni headers reenviados. No se cambió
trust proxy. No se agregó Expose-Headers: exponer el ID a JS cross-origin requiere
acuerdo FE/BE. El ID emitido coincide con el log de esa solicitud; no se mezclan
12 solicitudes concurrentes coordinadas por promesas, sin sleeps arbitrarios.

El default incorpora exclusivamente el hardening compatible de logging/UUID/404;
no activa globalmente parser, headers del perfil entero ni JSON 404. En el 404
HTML se agregan nosniff, no-store y CSP restrictiva. El optativo conserva nosniff,
no-referrer, no-store y CSP en éxitos, OPTIONS y errores. x-powered-by continúa
deshabilitado. No se configuraron HSTS ni TLS/proxies sin conocer infraestructura.

CORS conserva allowlist exacta, ausencia de Origin, wildcard explícito, preflight,
métodos y headers existentes. No añade orígenes ni credentials. El wildcard
refleja Origin solo si el operador lo configuró expresamente. Rechazo 403 ocurre
antes del parser; preflight termina sin pasar por validación de negocio. CORS no
equivale a autenticación ni impide clientes HTTP ajenos al navegador.

El parser optativo admite application/json y application/*+json, objetos/arrays,
rechaza primitivas con 400, JSON inválido 400, exceso 413 y tipo/charset/compresión
no soportados 415. Sin body no se exige Content-Type. Default **16384 bytes**,
configurable entre 1 y 1048576; no aprobado como límite universal de negocio.
Se verificaron límite exacto, un byte superior y transferencia chunked sin
Content-Length. No se añadió un parser al modo default.

Framing incorrecto (Content-Length corto/largo/duplicado y método no reconocido)
se probó por TCP local en ambos modos. Node puede emitir 400 o cerrar antes de
completar una respuesta; default puede terminar en 404 antes de consumir un body.
No se promete un error JSON de aplicación para un mensaje HTTP inválido. No se
instalaron handlers que registren rawPacket ni se ensayó request smuggling contra
un proxy real. Ese límite de evidencia es importante para Vercel.

## 6. Rondas y evidencia

| Ronda | Trabajo | Resultado real |
|---|---|---|
| 1: línea base | Suite completa sin cambios de esta entrega | 102/102 |
| 2: seguridad | Cuatro nuevas regresiones fallaron antes del fix; luego logging/404/runtime | 106/106 suite completa tras corregir también retorno de Promise de consola |
| 3: robustez | 16 nuevas en total, concurrencia/abortos/framing/terminal/valores extremos | 118/118 suite completa; 16/16 focalizadas |
| 3b: reauditado | La prueba de next(error) repetido reveló H13; se corrigió dispatch y se verificó embedding/guarda runtime | 18 nuevas en total; suite completa 120/120 |
| 4: compatibilidad | Reconstrucción en memoria del código base, HTTP real y comparación | 13 evaluados: 11 compatibles, 2 cambios intencionales, 0 regresiones no deseadas |
| 5: final | npm ci una vez, typecheck, build, suite completa, diff y revisión documental | Ver validación final abajo |

La ejecución focalizada inicial que incluyó varios archivos detectó un rechazo
de consola no observado por un wrapper. Se corrigió devolviendo la promesa al
emisor; no se cambiaron esas expectativas para hacerla pasar. Las rondas posteriores
aprobaron. No se repitió npm ci en cada ronda: dependencias/lock no cambiaron.

Validación final local: Node 24.19.0; npm 11.17.0; TypeScript 5.9.3; Express 5;
strict/ESM NodeNext sin cambios. npm ci con no-audit/no-fund y timeout/reintentos
acotados instaló 99 paquetes desde lock existente. Typecheck, build, npm test
**120/120**, cero omitidas/fallos, y git diff --check aprobados. Tras H13 se
repitieron typecheck/build/suite sin reinstalar dependencias sin cambios.
Inspección AST de 21 módulos: sin ciclos de imports locales ni any explícitos.
No es un análisis exhaustivo formal ni una certificación de dependencias.

Los 18 casos nuevos están en test/http-hardening.test.js. Incluyen seguridad de
sinks, 404 por métodos, validación runtime, errores/cause, coerción de tipo parser,
logger lento, Zod concurrente, aborto real, stream parcial, propagación doble,
status de finish, chunked, framing, JSON anidado/Unicode/extremos acotados,
múltiples next tardíos y callbacks de embedding.
Las pruebas previas de apertura/cierre Mongo y obsolescencia Zod siguen aprobadas.

## 7. Matriz diferencial y cambios públicos intencionales

Se reconstruyeron siete módulos originales con git show del SHA base, compilador
instalado y mismas dependencias. Se compararon status, body, Content-Type,
CORS/Vary y x-powered-by. UUID, Date y otros valores no deterministas se verifican
por propiedad/correlación, no por igualdad entre procesos.

| Escenario | Antes BE-07.2 | Ahora default | Clasificación | Justificación |
|---|---|---|---|---|
| GET /health sin Origin | 200, JSON exacto | Igual | Compatible | Sin DB ni auth |
| HEAD /health | 200 vacío | Igual | Compatible | Sin body |
| Origin permitido | 200 | Igual | Compatible | Coincidencia exacta |
| Origin rechazado | 403 error:string fijo | Igual | Compatible | Política preservada |
| Origin con barra final | 403 | Igual | Compatible | No normaliza |
| Origin con puerto explícito | 403 | Igual | Compatible | No equipara |
| Sufijo de host | 403 | Igual | Compatible | No permite dominio parecido |
| Wildcard configurado | 200/reflejo sin credentials | Igual | Compatible | Configuración explícita |
| Allowlist vacía con Origin | 403 | Igual | Compatible | No abre acceso |
| OPTIONS permitido | 204 | Igual | Compatible | Preflight existente |
| Ruta inexistente | 404 HTML con pathname | 404 HTML constante | Cambio intencional de seguridad | Elimina reflexión |
| POST /health | 404 HTML con pathname | 404 HTML constante | Cambio intencional de seguridad | No añade endpoint |
| Error inesperado | 500 JSON fijo, log raw | Mismo HTTP, log DTO | Compatible en HTTP | Cambio de seguridad del logger se prueba aparte |

Adicionalmente hay X-Request-ID generado en el default, logs de error cambiados y
headers de 404 reforzados: cambios intencionales transversales, no se ocultan bajo
la comparación de cuerpos. **No son 13 respuestas idénticas.** El modo optativo
mantiene JSON 404 y añade sus controles conforme a las pruebas ya existentes.

## 8. Riesgos residuales y decisiones externas

- No quedan rutas demostradas de filtración mediante los sinks propios o el 404
  en los perfiles auditados. Esto no asegura ausencia universal de vulnerabilidades.
- BE-03: aprobar envelope definitivo, mensajes/códigos públicos, detalle de campos,
  lectura cross-origin del ID y transición del parser frontend. El default mantiene
  HTML 404 genérico para reducir ruptura; quien dependía de su texto verá otro.
- El perfil completo sigue optativo. Mantener 16 KiB configurable hasta conocer
  DTO/cargas; acordar media types/compresión/caché por operación. Activar globalmente
  ese perfil requiere pruebas FE/BE y configuración explícita del servidor.
- Logger best effort y adaptadores personalizados son límites confiables del
  servidor; no hay garantía de auditoría durable ni timeout de cualquier callback.
  Un alias estático mal elegido por el desarrollador puede contener información:
  no se debe derivar de datos de usuarios aunque pase la sintaxis del identificador.
- Node o la plataforma pueden registrar errores propios de arranque/transporte;
  no se modificó globalmente console ni se interceptó rawPacket. Deben revisarse
  logs/configuración efectiva en Preview antes de integrar, usando datos sintéticos.
- Vercel: default Express export sin listener, Node 24 y build local preservados.
  Falta Preview autorizado, configuración real de proxies/TLS, headers, logs y límites.
  Un push puede generar Preview automático; esta entrega no autoriza ni lo ejecuta.
- No hay sesión, aislamiento de dominio, rate limiting distribuido ni DB readiness.
  Son exclusiones de etapa, no funcionalidades declaradas implementadas.
- BE-02/Atlas e integración real de dependencias siguen pendientes; no se infirieron
  modelos físicos ni se modificó Mongoose para justificar esta entrega.

## 9. Activación, rollback y publicación

Logging sanitizado, UUID y 404 genérico están activos desde el inicio del default.
La migración del resto debe usar una decisión explícita del servidor, nunca un
header/query del cliente. Secuencia propuesta: contrato BE-03 → pruebas por perfil
→ Preview autorizado del SHA revisado → revisión de equipo → integración. No se
implementó un flag de entorno adicional ni se cambiaron settings remotos.

Rollback: restaurar únicamente parser/envelope/configuración del modo compatible
si se detecta ruptura, manteniendo siempre el logging DTO, UUID y 404 no reflectante.
No recomendar volver a un artefacto con H01/H05. Conservar SHA/artefacto revisado y
repetir health/CORS/negativas; no reset/rebase/force push de ramas compartidas.

**Apta para PR Draft: SÍ**, técnicamente y de forma local. La revisión de equipo,
BE-03, integración y Vercel permanecen pendientes, sin presentar una vulnerabilidad
alta conocida como aceptable. Publicar requiere una instrucción posterior; no se
realiza aquí y BE-08 no está Done. La matriz de requisitos está en
[MATRIZ_BE08_SEGURIDAD_Y_REGRESION.md](MATRIZ_BE08_SEGURIDAD_Y_REGRESION.md).

## 10. Archivos y controles de alcance

Nuevos de esta entrega: src/middlewares/terminal-error.middleware.ts,
src/http/protect-application.ts, test/http-hardening.test.js, este informe y la matriz.
Modificados respecto de BE-08.2: app.ts, application.error.ts, error-response.ts,
infrastructure.ts, request-observability.ts, legacy-error.middleware.ts,
not-found.middleware.ts, health.test.js, health-layers.test.js,
http-infrastructure.test.js, README y los dos informes BE-08 anteriores.

Sin dependencias nuevas. Sin cambios package/lock, config de entorno, scripts,
Vercel, validación BE-07.2 ni manager Mongo. Sin modelos ni endpoints de negocio.
Índice vacío, HEAD y ramas anteriores sin modificar. Árbol con cambios esperados.
El informe BE-05 local continúa sin seguimiento, SHA256
`6445DC2925627E49F9C8EEE03BAD3DF67362761DC155DD4E9DF422A6280A5E5D`.
No se usaron credenciales reales ni se inició BE-09.
