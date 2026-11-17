# Matriz BE-08 — Seguridad, robustez y regresión

Fecha: 17/11/2026. Evaluación local BE-08.3/08.4/08.5 sobre base
`04cf46155ca179a80127cfdda56ccbb0a59947c9`.
Estados: Cumple, Cumple parcialmente, No cumple, No verificable.
Cumple significa evidencia suficiente para el alcance local descrito, no una
certificación universal. Un pendiente externo no se marca como probado.

## Evidencia utilizada

- **BASE**: npm test inicial, 102/102.
- **H**: test/http-hardening.test.js, 18 casos nuevos.
- **I**: test/http-infrastructure.test.js, 29 casos.
- **L**: test/health.test.js, health-layers.test.js y app-isolation.test.js.
- **Z**: test/request-validation.test.js; incluye pruebas runtime, tipos y obsolescencia.
- **M**: test/mongodb.test.js, conexiones simuladas y ausencia de conexión al importar.
- **D**: 13 escenarios HTTP contra siete módulos originales obtenidos por git show.
- **F**: npm ci una vez, typecheck/build/npm test final: 120/120; diff --check.
- **A**: revisión de fuentes, AST/imports locales e inventario Git.

La explicación de hallazgos, correcciones, fases y matriz diferencial completa
está en [INFORME_BE08_3_HARDENING_SEGURIDAD.md](INFORME_BE08_3_HARDENING_SEGURIDAD.md).

## Requisitos evaluados

| Requisito / fase | Estado | Evidencia | Alcance / pendiente |
|---|---|---|---|
| Rama, remoto, identidad y base correctos | Cumple | A: status/config/rev-parse | Sin cambios de rama o historial |
| Inventario de src, scripts, entrada y configuración | Cumple | A: lectura de módulos/package/tsconfig/Vercel | 21 módulos TS inspeccionados al cierre |
| Mapa request/error/logger/respuesta y alternativas | Cumple | Informe §1 | Incluye transporte, abortos y agotamiento de stack |
| Línea base de 102 pruebas | Cumple | BASE | Antes de corregir esta entrega |
| Error original nunca entregado al sink propio | Cumple | H: legacy projection y callback externo | Incluye cause/propiedad no enumerable |
| Contrato logger tipado y cerrado en runtime | Cumple | H: object status/code, labels y finish; A | DTO nuevo, primitivos y Object.freeze |
| Authorization/Cookie/password/token/URI/query/path no registrados | Cumple | H + I: cinco marcadores y entradas sensibles | Se verifica ausencia en argumentos del sink, no solo JSON HTTP |
| Excepciones y metadata extra no copiadas | Cumple | H + Z + I | Sin spread del Error/Request hacia logs |
| Logs útiles y correlacionados | Cumple | H: UUID/error code/status; I | Default errores; optativo ciclo completo |
| Logger lento no bloquea HTTP | Cumple | H: promesa diferida | Entrega durable no garantizada |
| Logger sync/async fallido no expone su causa | Cumple | I + L; ronda 2 | Wrappers devuelven Promise al emisor |
| Sanitización sin depender de regex de secretos | Cumple | A + H | Allowlist y construcción, regex solo para alias sintáctico |
| Dos pruebas históricas revisadas conservando intención | Cumple | L: HTTP 500 + una llamada segura | Cambio deliberado de contrato interno |
| 404 default sin pathname sensible | Cumple | H: GET/HEAD/POST/PUT/PATCH/DELETE | HTML genérico, status 404 |
| 404 optativo seguro | Cumple | I + H | JSON fijo, sin URL/stack |
| Sin cambio global al envelope definitivo BE-03 | Cumple | A + D | error:string transitorio; contrato final pendiente |
| Errores Zod esperados → 400 optativo | Cumple | I + H + Z | No se impone 400 global a legacy |
| Refinamientos async rechazados → 500 seguro | Cumple | I + Z; pruebas aisladas previas | Inputs/causas descartados |
| Body/params/query, coerciones y transformaciones | Cumple | H: 12 concurrentes; Z | Sin modificar implementación BE-07.2 |
| Resultados Zod obsoletos y acceso no validado | Cumple | Z | Regresiones de etapa anterior conservadas |
| Errores de middleware/controller/service/dependencia | Cumple | H + L + I | Fallos sintéticos; 503 declarado, sin DB real |
| String/objeto/null/undefined/getters/status inválido | Cumple | H + I | Status de éxito en error no termina como 200 |
| JSON malformado y primitivas | Cumple | I + H | Parser optativo estricto |
| JSON válido, arrays, Unicode, controles y nesting acotado | Cumple | H + I | No es fuzzing exhaustivo ni aprobación de DTO |
| 400/413/415 controlados | Cumple | I + H | Tipos/charset/compresión y tamaños |
| Sin coerción de objetos desconocidos en tipo parser | Cumple | H: toString no ejecutado | Comparaciones estrictas de strings |
| 16 KiB exactos y un byte superior | Cumple | I | 16384 acepta / 16385 rechaza |
| Límite apropiado para todos los contratos de negocio | No verificable | No existen DTO definitivos aprobados | BE-03; conservar configurable/optativo |
| Rango de configuración del límite | Cumple | I + A | Entero 1..1048576; default 16384 |
| Sin body y Content-Type no requerido | Cumple | I | No añade validación a health |
| Chunked sin Content-Length | Cumple | H | JSON válido y exceso 413 |
| Content-Length corto/largo/duplicado | Cumple parcialmente | H: TCP local en ambos modos | Node puede cerrar/400; falta proxy Vercel real |
| GET/HEAD/POST/PUT/PATCH/DELETE/OPTIONS/desconocido | Cumple | H + I + L + D | Sin endpoints nuevos; desconocido puede rechazarse en Node |
| Headers nosniff/cache/CSP/referrer y x-powered-by | Cumple parcialmente | I + H + A | Perfil completo optativo; default 404 reforzado, x-powered-by off global |
| CORS exacto, sin Origin, wildcard explícito, rechazo | Cumple | L + I + D | No se agregaron orígenes |
| Preflight/métodos/headers/CORS credentials | Cumple | I + L + D | Política previa; sin credentials global |
| Orden CORS antes de parser; headers/ID en errores | Cumple | I | 403 precede a 400 si Origin rechazado |
| UUID seguro y cliente/proxy IDs ignorados | Cumple | H + I; fuente randomUUID | No se cambió trust proxy |
| Requests concurrentes y separación de resultados | Cumple | H + I + Z | 12 solicitudes coordinadas sin sleeps |
| Error simultáneo no altera otro request | Cumple | H: validación concurrente/errores mixtos | Correlación por UUID y status |
| finish/close no duplican finalización | Cumple | I + H | Prueba unitaria y aborto TCP real |
| Error tardío no revive una respuesta cerrada | Cumple | H | Esperas por eventos/promesas, sin temporizadores arbitrarios |
| Headers ya enviados y carrera async | Cumple | I + H | No segunda respuesta; cierre terminal seguro |
| Errores concurrentes sobre un Response | Cumple | H | A lo sumo un send |
| Múltiples next(error) tardíos no alcanzan logger raw de Express | Cumple | H: regresión primero falló; ambos modos tras fix | Callback final de dispatch propio |
| Callbacks de embedding no reciben Error original | Cumple | H: dispatch protection | Error nuevo fijo; el padre debe proteger su propio logger |
| Integración Express dispatch validada en runtime | Cumple | H + A | Una aserción de tipos tras guard; dependencia explícita de Express 5 instalado |
| Ausencia de ciclos/any explícito en módulos propios | Cumple | A: AST | No sustituye prueba formal de seguridad |
| Reutilización de módulos sin refactor ajeno | Cumple | A: diff | No reescritura de Mongo, Zod o capas de health |
| Preservación HTTP de health, CORS y arranque | Cumple | L + D | UUID nuevo es adición intencional |
| 13 escenarios evaluados y clasificados | Cumple | D | 11 compatibles + 2 cambios de seguridad; no 13 idénticos |
| Regresiones HTTP no justificadas | Cumple | D + L | Ninguna detectada dentro de los casos probados |
| Preservación Mongoose/sin conexiones al importar | Cumple | M + A | Sin Atlas ni datos reales |
| Node 24 / strict / ESM / build / default Express export | Cumple | F + L + A | Compatibilidad local; listener separado |
| Operación real en Vercel Preview | No verificable | No desplegado ni consultado | Autorización futura, SHA/entorno/settings/logs/HTTP |
| Proxies/TLS/HSTS efectivos | No verificable | Sin acceso remoto en esta tarea | No se inventaron settings |
| Exposición del ID a JavaScript cross-origin | Cumple parcialmente | A + I | Header emitido, no Expose-Headers nuevo; decisión FE/BE |
| Envelope final BE-03 y lectura frontend | No verificable | Contrato no aprobado en esta tarea | Revisar parser/mensajes/transición de 404 |
| Observabilidad durable, retención y permisos de logs | No verificable | Sink local best effort | Revisión operativa futura |
| Cualquier adaptador personalizado termina en tiempo acotado | Cumple parcialmente | I: fallos; A | Código servidor confiable; sin timeout universal para Promise arbitraria |
| npm ci/typecheck/build/tests/diff check finales | Cumple | F | 120/120, cero fallos/omitidas |
| Sin dependencias adicionales | Cumple | A: package/lock idénticos | Una reinstalación final desde lock |
| Sin secretos incorporados al delta | Cumple | A + revisión y búsqueda acotada | No se afirma un escaneo de toda la historia ni de servicios externos |
| Informes/README/matriz actualizados | Cumple | Documentos y enlaces locales verificados | Estados anteriores identificados como históricos |
| Sin commit/push/PR/merge/deploy/Atlas/BE-09 | Cumple | A: HEAD/index/ramas; alcance de comandos | No hay autorizaciones externas inferidas |
| main/dev/ramas anteriores e informe BE-05 preservados | Cumple | A: SHA y SHA256 | Informe BE-05 sigue fuera de seguimiento |
| Sin hallazgos altos/críticos conocidos abiertos del alcance propio | Cumple | H + I + revisión final | No es promesa universal de ausencia de vulnerabilidades |

## Decisión de salida

**BE-08 apta para publicación Draft: SÍ**, como evaluación técnica local. No se
publicó y BE-08 no está Done. Los pendientes externos indicados no se convierten
en verificaciones aprobadas. Un futuro push puede generar Preview automático:
requiere instrucción posterior y revisión del efecto, sin promoción a Production.
