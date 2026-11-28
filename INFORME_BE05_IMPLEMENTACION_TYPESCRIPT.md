# BE-05.1 — Implementación local de Express en TypeScript

**Fecha:**16/11/2026. **Estado:** implementada y auditada localmente; pendiente de Preview Vercel, revisión e integración. **BE-05 no está Done.**

## 1. Autorización y alcance

El usuario comunicó la decisión de migrar la base existente conservando Node24, Express5 y comportamiento, y autorizó explícitamente «Ejecutar la migración local BE-05.1», incluida la instalación de cuatro dependencias de desarrollo. El alcance y la autorización están en [APROBACION_TECNICA_BE05.md](APROBACION_TECNICA_BE05.md). La [evaluación BE-05.0](INFORME_BE05_PREPARACION_TYPESCRIPT.md) se mantiene como evidencia histórica, sin reescribir sus resultados anteriores.

Solo se migró infraestructura existente. Sin MongoDB, autenticación, Zod, DTOs de negocio, normalizadores, capas BE-06 o endpoints nuevos. La jerarquía de dominio y propuestas de los PR #2/#3/#4 no se incorporaron a código ni a esta rama.

## 2. Archivos y responsabilidades

| Archivo | Resultado |
|---|---|
| src/app.js→src/app.ts | Factory createApp y export default; CORS, GET health y error handler legacy conservados. AppOptions y convención de error tipadas, sin validación runtime nueva |
| scripts/start.js→scripts/start.ts | Listener separado; mismo import relativo .js, parseInt/default PORT y listen. Importar app no abre puerto |
| tsconfig.json | Strict, NodeNext, target ES2022, rootDir raíz y outDir dist; compila únicamente src/scripts TS |
| package.json/package-lock.json | Cuatro devDependencies exactas y scripts, sin cambios de paquetes runtime |
| test/health.test.js | Cinco pruebas originales conservadas y regresión HTTP/arranque/entorno sobre compilado |
| test/app-isolation.test.js | Prueba de independencia de factory/CORS en segundo archivo, descubierta por npm test |
| README.md | Uso de build/start, dos terminales watch, pruebas, runtime y Preview pendiente |
| Informes/contrato BE-05 | Preparación, autorización, implementación y auditoría; evidencia local separada del despliegue pendiente |

El JS emitido es dist/src/app.js y dist/scripts/start.js, excluido de Git. vercel.json, .env.example y .gitignore no se modificaron. No se conservan fuentes JS duplicadas de los dos módulos renombrados.

## 3. Herramientas y scripts

Node local24.19.0/npm11.17.0. Runtime preservado: Express5.3.0 y cors2.8.6, con sus rangos declarados originales. DevDependencies directas fijadas: typescript5.9.3, @types/node24.19.2, @types/express5.0.6 y @types/cors2.8.19. Sus13 entradas nuevas de lock son todas dev; ninguna entrada runtime previa se alteró.

- typecheck: tsc -p tsconfig.json --noEmit.
- build: tsc -p tsconfig.json.
- dev: build inicial seguido de Node watch sobre dist/scripts/start.js, con .env opcional.
- dev:build: tsc watch en segunda terminal.
- start: Node ejecuta dist/scripts/start.js con --env-file-if-exists=.env; requiere build previo y no usa compilador en runtime.
- test: build seguido de node --test, con descubrimiento automático de todos los archivos de prueba.

La auditoría corrigió la restricción inicial del script test a un único archivo. Un error de compilación no emite JS nuevo, pero puede quedar sirviéndose el compilado válido anterior en desarrollo; no interpretar health200 como typecheck correcto. El build necesita devDependencies durante compilación; la ejecución del compilado no.

## 4. Comportamiento preservado

GET /health público devuelve200 y {"status":"ok"}; HEAD automático conserva200 sin body. x-powered-by está deshabilitado. CORS sigue con matching exacto del Set, trim/separación por coma, permiso sin Origin, wildcard que refleja Origin/Vary y sin credentials nuevas. Origen denegado conserva403 {"error":"Origin not allowed by CORS"}. Error interno conserva500 {"error":"Internal server error"} y logging interno. Rutas/métodos no registrados siguen404 HTML.

No se agregó parser JSON, error uniforme futuro, autenticación o nuevas reglas PORT/env. Una aserción estática de error no se presenta como saneamiento o validación runtime.

## 5. Validaciones y auditoría

[INFORME_BE05_AUDITORIA_TYPESCRIPT.md](INFORME_BE05_AUDITORIA_TYPESCRIPT.md) contiene método, hallazgos y límites. Resultados repetidos antes del commit solicitado en BE-05.3:

| Comprobación | Resultado local |
|---|---|
| npm ci --no-audit --no-fund | Correcto y reproducible con el lock existente |
| npm run typecheck | Sin errores |
| npm run build | Correcto |
| npm test |18/18 aprobadas,0 fallos; ambos archivos descubiertos |
| Comparación JS origin/dev frente al compilado |13/13 escenarios HTTP equivalentes en status, body y headers contractuales |
| git diff --check | Sin errores; archivos nuevos revisados además para espacios/enlaces |

La auditoría también verificó build limpio en temporal sin dist previo, dev/watch/restart y error de tipos sintético sin emisión nueva. En un fixture con npm ci --omit=dev, sin compilador, fuentes TS ni tsconfig, npm start atendió health y rechazo CORS. No se modificó el entorno persistente ni se utilizaron datos de producción.

## 6. Vercel y publicación sin despliegue

La fuente prevista es src/app.ts con import Express/default export y sin listen; se conserva framework express/fluid de vercel.json. La validación local no demuestra el funcionamiento en Vercel ni en Linux: se requieren logs, ajustes efectivos y humo de un Preview autorizado, seguido de revisión/integración. No se ejecutaron comandos Vercel ni cambios de variables remotas.

**Hallazgo previo al push BE-05.3:** la cuenta camiegonzalez y permisos de escritura se verificaron. El estado GitHub del commit BE-04 b2deb9bb2b11adbf5f96e81d3a418a72c6492c96 contiene un status Vercel «Deployment has completed» con enlace a un deployment. Eso demuestra integración activa en publicaciones previas; no prueba que el despliegue haya validado TypeScript. La restricción actual prohíbe desplegar, por lo que debe confirmarse que publicar esta rama/crear su PR no activará otro deployment antes de hacerlo. No se deshabilitó ni modificó configuración remota por esta tarea.

El commit local puede prepararse; push y PR quedan condicionados a esa comprobación. La autorización para publicar no se interpreta como autorización de un Preview automático contra la restricción expresa del pedido. Históricos de los informes de auditoría se refieren a sus etapas, no afirman que este commit o PR ya estén publicados.

## 7. Pendientes para cerrar BE-05

1. Publicar para revisión solo cuando se pueda respetar la restricción de no despliegue automático.
2. Autorizar y verificar un Preview posterior: entrada fuente, Node/build/install, HTTP/CORS/OPTIONS y rutas negativas, sin credenciales Atlas.
3. Revisar e integrar con criterios de aceptación satisfechos; no fusionar ni marcar Done automáticamente.

No se inició BE-06 ni se modificaron otras ramas, PR #2/#3/#4, frontend, ingesta o datos MongoDB.
