# BE-05.2 — Auditoría técnica de la migración TypeScript

**Fecha:**16/11/2026, America/Buenos_Aires. **Resultado:** apta para publicar como PR Draft de revisión, sin publicarla en esta tarea. Implementación local verificada; BE-05 no está Done. Preview Vercel, revisión e integración siguen pendientes.

## 1. Resumen ejecutivo

La conversión conserva el comportamiento HTTP observado del JavaScript de origin/dev y funciona en Node24.19.0. Strict/typecheck/build aprobaron, la instalación se reprodujo con npm ci y la suite final aprobó **18/18 pruebas**. Se ejecutaron además **13 escenarios diferenciales HTTP** contra la app anterior y una verificación aislada de build limpio, desarrollo/watch y runtime sin dependencias de desarrollo.

Se encontró y corrigió una regresión del comando de pruebas: BE-05.1 restringía npm test a un archivo, mientras el original descubría todos los tests. Se restauró node --test sin lista fija y se añadió una prueba de aislamiento en un segundo archivo. Se reforzó la coincidencia exacta CORS. **No se detectó ni corrigió una regresión funcional en src/app.ts o scripts/start.ts**; no se modificaron contratos para hacer pasar pruebas.

## 2. Git e identidad

- Rama conservada: feature/be-05-preparacion-typescript. Origin: https://github.com/Proyecto-Agro-Org/be-agro.git.
- Identidad local: Camila Gonzalez / camiiigonzalez1503@gmail.com; configuración credential.https://github.com.username=camiegonzalez. El conector GitHub confirmó login camiegonzalez. No se usaron ni modificaron credenciales laborales. No se probó autenticación de push porque no se publica nada.
- HEAD y referencias locales origin/dev/main/dev conservan `1bb20f76b7a739f42c75b37b9a64315276560ec1`. Consulta GET de la rama dev remota confirmó el mismo SHA, sin fetch ni cambios de referencias durante esta auditoría.
- Pruebas de ancestro negativas para los commits exclusivos de BE-02 (28556ff485f2a9f2f2239c0a612ac623dc33fdef), BE-03 (c2a4b3175eef12b91e0d1e554082b4d281cdbe55) y BE-04 (b2deb9bb2b11adbf5f96e81d3a418a72c6492c96). No se copiaron sus documentos ni modificaciones de schema/diagrama.
- Diff contra origin/dev y archivos sin seguimiento revisados; nada staged. Sin commit, push, PR, cambios de rama o despliegue.

## 3. Inventario revisado

| Clasificación respecto de origin/dev | Archivos | Resultado |
|---|---|---|
| Migración conceptual por renombre | src/app.js→src/app.ts | Factory/default export, mismos middleware y ruta. Tipos locales y error handler tipado |
| Migración conceptual por renombre | scripts/start.js→scripts/start.ts | Contenido equivalente byte a byte normalizando CRLF/LF; import .js, PORT y listen preservados |
| Modificados | package.json, package-lock.json | Cuatro devDependencies exactas, scripts y corrección del descubrimiento; sin cambio de entradas runtime |
| Modificados | test/health.test.js, README.md | Cinco tests originales conservados y regresiones; documentación de herramientas, watch, runtime y Preview pendiente |
| Nuevos de preparación previa | INFORME_BE05_PREPARACION_TYPESCRIPT.md, APROBACION_TECNICA_BE05.md | Evaluación histórica intacta y registro de autorización local; este último actualizado con BE-05.2 |
| Nuevos de configuración/regresión | tsconfig.json, test/app-isolation.test.js | Compilación strict y prueba independiente que ahora descubre npm test |
| Nuevo de esta auditoría | INFORME_BE05_AUDITORIA_TYPESCRIPT.md | Este informe |
| Conservados | vercel.json, .env.example, .gitignore, IMPLEMENTATION_PLAN.md, DEFINITION_OF_DONE.md y demás base | Contrastados sin modificaciones de alcance ajeno ni marcado Done |

Git muestra los JS originales como D y los TS como ?? porque todavía no se añadieron al índice: no se forzó staging para mostrar renames. No hay borrado independiente de módulos ni segunda fuente JS paralela.

`dist/src/app.js` y `dist/scripts/start.js` son los únicos JS emitidos de la app; dist, node_modules y documentacion-referencia/ están excluidos/no versionados. Al cerrar BE-05.2 no existía el informe opcional de implementación: la evidencia estaba en APROBACION_TECNICA_BE05.md §13/14. En BE-05.3 el usuario solicitó expresamente [INFORME_BE05_IMPLEMENTACION_TYPESCRIPT.md](INFORME_BE05_IMPLEMENTACION_TYPESCRIPT.md), que se creó como resumen trazable sin cambiar las conclusiones de la auditoría.

## 4. Hallazgos y correcciones BE-05.2

### H01 — Descubrimiento de pruebas reducido: corregido

**Causa:** el script migrado era `npm run build && node --test test/health.test.js`. Aunque pasaran16 pruebas, un nuevo archivo no se ejecutaría mediante npm test; el original usaba descubrimiento automático.

**Demostración:** tras crear test/app-isolation.test.js y agregar el caso de Origin exacto, el script anterior reportó17 pruebas del único archivo; ejecutar directamente el segundo archivo reportó1 prueba adicional que npm test había omitido.

**Corrección:** `npm run build && node --test`, conservando build previo y node:test. La suite final descubre ambos archivos y reporta18 aprobadas. La regresión de segundo archivo verifica comportamiento útil: dos instancias de createApp mantienen distintas allowlists CORS, sin compartir configuración mutable. No se agrega un test que compare simplemente el texto del script.

### H02 — Cobertura de coincidencia exacta CORS: reforzada

No había una prueba permanente de orígenes parecidos al permitido. Se agregó rechazo de barra final, puerto explícito y sufijo de dominio diferente. Todos reciben403 legacy sin allow-origin, según la regla existente. No fue necesario cambiar Set.has ni normalizar URLs.

### Observaciones sin defecto funcional

- Configuración explícita de moduleResolution, esModuleInterop, allowJs:false y casing puede repetir defaults inferidos, pero documenta intención y no genera contradicción. No se quitaron opciones por refactorización estética.
- El cast `error as LegacyError` es una aserción estática acotada de la convención heredada, **no validación runtime**. Se preservó deliberadamente el acceso statusCode??500. Suprimirlo mediante un nuevo saneamiento de errores podría cambiar el contrato; no se hizo en una migración que debe conservarlo.
- Las firmas genéricas de Express pueden usar any en declaraciones de terceros; las fuentes TS propias no introducen any ni supresiones ts-ignore/ts-nocheck. Esto no afirma validación de payloads inexistentes.
- Watch puede servir el último compilado válido ante un error; es una limitación documentada y verificada, no evidencia de que el TS erróneo pasó a producción. Build/test fallan antes de aceptar un compilado nuevo.

## 5. Dependencias y reproducibilidad

Entorno: Node v24.19.0, npm11.17.0; engines24.x, type module. Versiones instaladas, package y lock coherentes:

| Dependencia | Versión | Clase / evidencia |
|---|---|---|
| express |5.3.0 (rango ^5.1.0) | Runtime sin cambios |
| cors |2.8.6 (rango ^2.8.6) | Runtime sin cambios |
| typescript |5.9.3 | Dev, versión exacta |
| @types/node |24.19.2 | Dev, línea24 |
| @types/express |5.0.6 | Dev, línea5 |
| @types/cors |2.8.19 | Dev, versión exacta |

Las13 entradas nuevas del lock son de desarrollo: cuatro directas y nueve transitivas de declaraciones/compilador. Todas las entradas runtime previas permanecen iguales a origin/dev; no se añadió Mongoose, Zod, auth, runner o bundler. npm ci --no-audit --no-fund terminó correctamente, también repetido después de la corrección. Los flags evitan auditoría de vulnerabilidades/funding; no se afirma haber ejecutado npm audit o certificado seguridad de todo el historial.

**Build y runtime son fases distintas:** compilar necesita TypeScript y sus declaraciones durante build/CI. Un checkout limpio instalado solo con --omit=dev no puede compilar TS; no se promete lo contrario. La ejecución del JS ya compilado sí se comprobó sin devDependencies (§8).

## 6. Auditoría TypeScript y ESM

Se leyó tsconfig.json y se ejecutó `tsc --showConfig`: solo incluye src/app.ts y scripts/start.ts. Strict activa noImplicitAny, strictNullChecks, strictFunctionTypes y demás comprobaciones correspondientes. No se usa skipLibCheck para ocultar incompatibilidades.

NodeNext/NodeNext con type module, target/lib ES2022 y imports relativos .js producen ESM ejecutable por Node24. rootDir `.` conserva las rutas src/scripts dentro de dist; outDir no pisa fuentes. verbatimModuleSyntax permite borrar el import type de ErrorRequestHandler, sin import runtime de tipos. noEmitOnError impide nueva emisión fallida, sin limpiar artefactos previos. Los tests son JS deliberadamente, fuera del tsc; no se presentan como tests tipados.

AppOptions usa ReadonlySet<string>; getAllowedOrigins y callbacks conservan su comportamiento. El handler de cuatro parámetros está contextualizado como ErrorRequestHandler y recibe unknown; usa la aserción legacy ya descrita. CORS genera Error con statusCode403, sin nuevas reglas HTTP. src/app.ts exporta la app sin listen; scripts/start.ts abre puerto con el mismo parseInt/default. No hay cambios de runtime por mover el error handler a una variable tipada.

Las opciones de módulos son coherentes con el caso de ejecutar JS emitido en Node. Referencia primaria reconsultada: [TypeScript — opciones para Node](https://www.typescriptlang.org/docs/handbook/modules/guides/choosing-compiler-options.html). Node no hace chequeo estático por ejecutar TypeScript directamente; aquí no se depende de type stripping ni loader TS: [Node24 — TypeScript](https://nodejs.org/docs/latest-v24.x/api/typescript.html).

## 7. Resultados de comandos en el workspace

| Validación final posterior a corregir H01 | Resultado |
|---|---|
| npm ci --no-audit --no-fund | Exit0;80 paquetes instalados coherentes con lock |
| npm run typecheck | Exit0, sin errores |
| npm run build | Exit0, emisión JS correcta |
| npm test | Exit0;18 tests,18 aprobadas,0 fallos; build previo y ambos archivos descubiertos |
| git diff --check | Sin errores; revisión explícita adicional de archivos nuevos y enlaces |
| Revisión de package/lock | Cuatro dev directas y13 entradas dev nuevas; runtime previo intacto |

Las18 pruebas incluyen las cinco originales y13 adicionales: headers/HEAD, método negativo, wildcard, coincidencia exacta, allowlist vacía,500/logging, import sin listener, arranque, .env/trim, prioridad del entorno, PORT inválido e independencia de factories. No se sustituyeron assertions anteriores para ocultar fallos.

## 8. Build limpio, watch y producción sin herramientas dev

Se creó un fixture temporal identificado fuera del proyecto y sin secretos, con copias de los dos TS, package/lock y tsconfig; no se copiaron .env real, referencias, Git, frontend o ingesta.

1. npm ci, typecheck y build desde directorio sin dist: aprobados; emisión de los dos JS esperados, sin posibilidad de reutilizar artefactos viejos del workspace.
2. npm run dev real y tsc watch en procesos propios: app arrancó y atendió health.
3. Error de tipos sintético solo en la copia temporal: TS2322 visible, JS anterior sin cambios y última app válida aún atendiendo200. Restaurada la copia, el compilador recuperó0 errores y Node reinició el servidor con health correcto. El TS del proyecto no fue tocado por esta prueba.
4. Cerrados watchers, npm ci --omit=dev en el fixture. Se confirmó ausencia física de typescript y los tres @types directos. También se retiraron de ese fixture las fuentes TS y tsconfig: no era posible que npm start dependiera de ellos silenciosamente.
5. npm start real sobre ese JS y solo dependencias runtime: health200 exacto y CORS403 legacy correctos. No loader ni compilador en runtime.
6. Se cerraron exclusivamente los procesos hijos creados y se eliminó el fixture tras verificar su ruta real dentro de la carpeta temporal y el prefijo propio. Las copias originales del workspace conservaron su contenido.

Los puertos se asignaron para pruebas, no se ocupó por obligación el3000 de otro proceso. Default/parseo PORT se contrastaron con la fuente anterior; PORT0 y PORT inválido se cubren en suite. .env sintético y prioridad se ensayan en hijos/temporales, sin cambiar variables persistentes ni configuración del proyecto. Estas pruebas fueron en Windows; no equivalen a una ejecución Linux/Vercel real.

## 9. Comparación HTTP antes/después

Se leyó el JS anterior mediante git show origin/dev:src/app.js y se importó en memoria; únicamente se resolvieron imports bare de express/cors a sus módulos instalados para poder cargar el módulo de datos. No se cambiaron sus rutas/handlers. Se comparó con dist/src/app.js en servidores locales efímeros separados, usando las mismas dependencias runtime preservadas.

Comparación exacta de status, body y headers seleccionados: content-type, allow-origin/methods/headers/credentials, Vary y x-powered-by. Se excluyeron headers volátiles como Date y puertos, no la semántica HTTP.

| Escenario | Anterior = migrado |
|---|---|
| GET health sin Origin |200, JSON {"status":"ok"}, sin x-powered-by |
| HEAD health |200 sin body |
| Origin permitido |200 y mismo allow-origin |
| Origin ajeno |403 legacy, sin allow-origin |
| Origin con barra final |403 legacy |
| Origin con puerto explícito diferente en texto |403 legacy |
| Origin con sufijo de dominio |403 legacy |
| Wildcard |200, Origin reflejado y Vary correspondiente, sin credentials |
| Allowlist vacía con Origin |403 legacy |
| Preflight con método/header solicitado |204 y headers iguales |
| GET desconocido |404 HTML |
| POST health |404 HTML |
| Fallo interno sintético |500 {"error":"Internal server error"}; un registro interno por app |

**13/13 escenarios diferenciales iguales.** Es evidencia de la superficie auditada, no una prueba universal para cualquier valor interno de error. No se endureció el comportamiento para hacer coincidir resultados; no se añadieron endpoints sintéticos a src.

## 10. Compatibilidad prevista con Vercel

La documentación oficial admite src/app.ts con import de Express y default export; la implementación cumple esa forma y no abre puerto al importarse. vercel.json conserva framework express/fluid:true. No existe otro app.js de fuente que compita con app.ts; el JS compilado está en dist y no entre los puntos de entrada fuente de la lista documentada. No se fija outputDirectory a dist ni se introduce un adaptador o rewrite nuevo. [Express en Vercel](https://vercel.com/docs/frameworks/backend/express).

Vercel documenta soporte Node24 y selección por major; no se garantiza el mismo patch que24.19.0 local. Preview debe confirmar versión efectiva. [Versiones Node Vercel](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions).

El build local/CI valida tsc y el runtime JS; la plataforma prepara su Function desde la entrada TS. No se presupone que ejecute npm start como servidor permanente ni que use dist como fuente de despliegue. Añadir build a package requiere revisar el comando efectivo/preset/overrides y disponibilidad de devDependencies durante la fase build. No se consultaron settings/variables remotos ni se ejecutó Vercel CLI, vercel build, Preview o deploy. La documentación de soporte no acredita ese proyecto desplegado.

No se observó conflicto local entre fuente y salida. **Compatibilidad de la plataforma todavía requiere Preview autorizado** con detección de entrada, build, Node, HTTP/CORS/OPTIONS y rutas negativas. Publicar una rama puede disparar un despliegue automático; revisar ese efecto antes del futuro push. No se modifica ni desactiva protección de la plataforma en esta auditoría.

## 11. Documentación y aceptación

[Preparación BE-05.0](INFORME_BE05_PREPARACION_TYPESCRIPT.md) permanece intacta y describe una evaluación anterior; sus resultados5/5 no sustituyen el estado actual. [Contrato/registro](APROBACION_TECNICA_BE05.md) conserva el registro histórico16/16 de BE-05.1 y se actualizó con el script/archivo de regresión y resultados18/18 de esta auditoría. README describe la implementación y el descubrimiento automático actual. El plan y DoD no se marcan completos: etapa2 completa incluye capacidades fuera de esta migración limitada.

| Criterio | Estado / evidencia |
|---|---|
| Reproducibilidad y cuatro devDeps | Satisfecho localmente: npm ci y diff de lock |
| Strict/ESM/compilación limpia | Satisfecho: typecheck/build y fixture sin dist |
| App/listener y arranque JS | Satisfecho: import sin puerto, npm start runtime-only |
| Cinco pruebas previas y nuevos bordes | Satisfecho:18/18 con descubrimiento automático |
| Health/CORS/errores legacy | Satisfecho en13 escenarios diferenciales y suite |
| Env/PORT/watch | Satisfecho para los casos ensayados; default contrastado por código, no puerto3000 forzado |
| Sin funcionalidades ajenas ni dependencias runtime nuevas | Satisfecho por revisión de diff/imports/lock |
| Vercel real, Linux y ajustes efectivos | Pendiente de Preview autorizado |
| Revisión de equipo e integración | Pendientes; no se crea PR ni se fusiona |
| DoD completo BE-05 | Pendiente: no cerrar por compilar o pasar tests locales |

## 12. Riesgos pendientes y recomendación

- No hay regresión funcional HTTP demostrada tras las correcciones de testing; se recomienda **publicar posteriormente como PR Draft para revisión**, con el alcance y límites aquí descritos. Este informe no autoriza ni realiza publicación.
- Resolver configuración efectiva de Vercel/Node/build en Preview y ejecutar su humo antes de integrar/promover. La ejecución Linux y condiciones serverless no se probaron aquí.
- Mantener presente que el build necesita herramientas dev y que watch puede servir salida anterior. No omitir build limpio/typecheck en el flujo de revisión.
- La convención legacy de errores y logging no está endurecida; el formato uniforme y seguridad futura pertenecen a BE-08. Los tipos no hacen seguro un payload desconocido por sí solos.
- Tipos/patches nuevos de Node o paquetes pueden requerir revisión futura; el lock actual y la versión fijada sí se probaron. No se actualizó ninguna versión en la auditoría.
- Reversión sigue siendo por rama/PR autorizado y eventual rollback de plataforma autorizado, sin force push ni cambios de datos; no se ejecutó reversión.

Para cerrar BE-05 faltan autorización/evidencia Preview, revisión e integración con criterios aplicables satisfechos. No se inició BE-06 ni se añadió MongoDB, autenticación, Zod o telemetría.

## 13. Alcance de seguridad y controles finales

Revisión de archivos cambiados/nuevos sin patrones de claves privadas, tokens GitHub/AWS o URI Mongo; no equivale a un escaneo de todo el historial ni de producción. npm ci no alteró credenciales, configuración global ni otros repositorios. No se enviaron archivos privados a validadores externos; solo lectura de documentación oficial y metadatos GitHub.

Enlaces locales, JSON de configuración, exclusiones, ramas, referencias y diff verificados al cierre, con revisión adicional de espacios/UTF-8 en los archivos nuevos. No se incluyeron temporales, compilados, node_modules o documentación de referencia; nada se añadió al índice. Sin acceso a Atlas ni cambios de frontend/ingesta.
