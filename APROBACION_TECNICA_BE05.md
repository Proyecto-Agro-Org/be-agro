# BE-05.1 — Contrato técnico y registro de implementación local

**Versión:** registro local2 ·16/11/2026. **Estado: implementación local autorizada y realizada; Preview, revisión e integración pendientes.**

Este documento conserva el contrato preparado y registra la autorización posterior del usuario para ejecutar la migración local, incluida la instalación de las cuatro dependencias. La decisión técnica y la respuesta «Ejecutar la migración local BE-05.1» constan en esta conversación. No implican revisión independiente del equipo, publicación, Preview o integración. El [informe BE-05.0](INFORME_BE05_PREPARACION_TYPESCRIPT.md) permanece sin cambios.

## 1. Fuentes, interpretación y condición de inicio

Fuente principal: INFORME_BE05_PREPARACION_TYPESCRIPT.md, especialmente §§6–13. Se contrastó con el [plan vigente](IMPLEMENTATION_PLAN.md), [especificación](ESPECIFICACION.md), [instrucciones](AGENTS.md), [DoD](DEFINITION_OF_DONE.md) y el código actual de app, arranque y pruebas.

El plan asigna a BE-05 la migración de Express sin perder health/CORS/Vercel y exige un contrato mínimo BE-02/03/04. La etapa2 también comprende BE-06/07/08; sus requisitos de capas, Mongoose, Zod y errores uniformes no se incorporan automáticamente a esta migración limitada.

El mínimo de esta migración conserva la superficie implementada, sin materializar contratos de negocio Draft y manteniendo sus decisiones abiertas para sus etapas. La decisión técnica del usuario confirma este alcance y posteriormente autoriza ejecutarlo localmente; no aprueba los PR #2/#3/#4 ni cierra sus decisiones. La migración de estos módulos no necesita Atlas, IoT, Google o Agronomía.

Rama actual verificada: `feature/be-05-preparacion-typescript`, base `1bb20f76b7a739f42c75b37b9a64315276560ec1`. No cambiar de rama ni incorporar commits exclusivos de otros PR como parte de esta preparación. Antes de implementar habrá que verificar nuevamente base y cambios concurrentes, preservando ambos documentos locales existentes.

## 2. Alcance autorizado propuesto

Convertir de manera controlada **solo los dos módulos de aplicación existentes** a TypeScript, con los ajustes de configuración, pruebas y documentación listados en §3. Conservar lógica, orden de middleware, imports/exports ESM, separación app/listener y comportamiento HTTP/entorno.

TypeScript verificará estáticamente tipos técnicos de estos módulos; no valida requests, configuración o errores en runtime por sí solo. No introducir `any`/`ts-ignore` propios para eludir el tipado ni aprovechar la conversión para cambiar reglas. La extracción MVC por recursos queda para BE-06.

El código ya separa `src/app.js` de `scripts/start.js`; conservar esa responsabilidad evita crear otro listener. No crear `src/server.ts` o `api/index.ts` adicional. La aplicación importable exporta `createApp` y default app sin abrir puerto; únicamente el módulo de arranque llama a listen.

## 3. Archivos afectados por la implementación futura

| Acción propuesta | Archivo(s) | Límite |
|---|---|---|
| Renombrar y tipar | src/app.js → src/app.ts | Misma factory/default export, CORS, health y handler; sin módulos de negocio |
| Renombrar y tipar | scripts/start.js → scripts/start.ts | Mismo parseInt de PORT, default3000, listen y mensaje de arranque; import ../src/app.js preservado para salida ESM |
| Crear | tsconfig.json | Opciones de §4; no configuraciones paralelas innecesarias |
| Modificar | package.json, package-lock.json | Cuatro devDependencies y scripts de §4; sin actualización incidental de Express/CORS o transitivas runtime |
| Modificar | test/health.test.js | Importar ../dist/src/app.js, mantener las cinco pruebas actuales y sus assertions/lifecycle; añadir regresiones pertinentes de §6 sin cambiar de runner |
| Crear como corrección BE-05.2 | test/app-isolation.test.js | Regresión de aislamiento de dos factories/CORS; evidencia de descubrimiento de múltiples archivos mediante node:test, sin nueva funcionalidad |
| Modificar | README.md | Instalación autorizada, build/start, dos terminales dev, source entry Vercel y límites de validación |
| Generar, no versionar | dist/src/app.js, dist/scripts/start.js | Artefactos del compilador; nunca una segunda fuente editada manualmente |
| Conservar | vercel.json, .env.example, .gitignore | Mismo framework express/fluid, entorno y exclusiones; dist ya está excluido |
| Conservar | Documentación base, informe BE-05.0 y este contrato | Sin alterar acuerdos/aprobaciones al implementar. Cualquier registro de aprobación posterior debe ser explícito y trazable |
| No incorporar | Documentos/commits exclusivos de PR #2/#3/#4 y documentacion-referencia/ | No merge/cherry-pick/copia automática; referencias locales fuera de Git |
| Eliminar | Ningún archivo de forma independiente | Solo desaparecen los paths JS renombrados; no conservar copias JS/TS paralelas |

Cualquier archivo adicional, nuevo paquete o cambio de contrato fuera de la tabla requiere revisar y aprobar una ampliación concreta antes de ejecutarla. La preparación original solo creó este contrato; tras la autorización posterior se aplicó el inventario de implementación y se actualizó este registro. El informe previo sigue intacto y sin seguimiento.

## 4. Dependencias, compilación y scripts propuestos

**Runtime nuevas:0. Dev nuevas:4.** Mantener `type:module`, `engines.node:24.x` y los paquetes HTTP actuales. El baseline auditado resuelve Express5.3.0 y cors2.8.6; no cambiar esas resoluciones para facilitar el tipado.

| DevDependency | Propósito | Política que se somete a aprobación | Versión exacta a registrar antes de instalar |
|---|---|---|---|
| typescript | Chequeo y emisión con tsc | Release estable compatible con Node24 y las opciones propuestas; sin seleccionar «latest» como garantía de ensayo |5.9.3 |
| @types/node | APIs de Node | Línea24 compatible con el runtime declarado |24.19.2 |
| @types/express | Declaraciones de Express | Línea5 para Express5; no instalar tipos4 por defecto |5.0.6 |
| @types/cors | Declaraciones de cors | Versión compatible con el paquete actual y el compilador elegido |2.8.19 |

Las versiones exactas de la tabla fueron seleccionadas técnicamente dentro de la autorización general del usuario para instalar las cuatro dependencias; no se le atribuye una selección manual de cada versión. Se fijaron con save-exact y se verificaron mediante npm ci, typecheck/build y pruebas. Ninguna entrada runtime previa del lock cambió. No se añadió runner/transpilador/watch supervisor, dotenv o bundler. Se mantiene node:test; Vitest/Supertest quedan fuera de este cambio.

Configuración a crear según §6 de BE-05.0: `target:ES2022`, `module:NodeNext`, `moduleResolution:NodeNext`, `strict:true`, `rootDir:.`, `outDir:dist`, `noEmitOnError:true`, `verbatimModuleSyntax:true`, `esModuleInterop:true`, `types:[node]`, `lib:[ES2022]`, `allowJs:false` y `forceConsistentCasingInFileNames:true`. Incluir `src/**/*.ts` y `scripts/**/*.ts`; excluir node_modules, dist, test y documentacion-referencia. No añadir aliases de paths o resolución bundler que oculten imports inválidos en Node.

Scripts del contrato, aplicados y ejecutados en la implementación local posterior:

```json
{
  "typecheck": "tsc -p tsconfig.json --noEmit",
  "build": "tsc -p tsconfig.json",
  "dev:build": "tsc -p tsconfig.json --watch --preserveWatchOutput",
  "dev": "npm run build && node --env-file-if-exists=.env --watch dist/scripts/start.js",
  "start": "node --env-file-if-exists=.env dist/scripts/start.js",
  "test": "npm run build && node --test"
}
```

Desarrollo en dos terminales:1) `npm run dev`, que realiza build inicial y ejecuta Node watch sobre JS;2) `npm run dev:build`, que observa y recompila TS. Un error de compilación puede dejar corriendo la última salida válida: health200 no sustituye typecheck/build aprobados. Reiniciar explícitamente ante cambios de .env. Producción local usa build previo más npm start; start no compila ni necesita TypeScript en runtime.

noEmitOnError no elimina un dist viejo. Las verificaciones de aceptación se hacen con artefactos nuevos en un checkout aislado limpio o con limpieza controlada únicamente de dist, verificando previamente su ruta. No introducir borrados generales/multiplataforma inseguros para resolver esa limpieza.

## 5. Comportamiento que debe preservarse

| Superficie existente | Contrato de regresión obligatorio |
|---|---|
| GET /health | Público,200 y JSON exacto {"status":"ok"}; sin conexión DB, autenticación ni nuevo prefijo |
| HEAD /health | Comportamiento automático actual de Express:200, sin body |
| Headers | JSON en health, x-powered-by deshabilitado y mismas reglas CORS; comparar headers contractuales, no valores variables como Date/puerto efímero |
| CORS_ORIGINS | Separación por coma, trim y eliminación de vacíos; Set con matching exacto, sin normalización nueva de dominios |
| Sin Origin / wildcard | Sin Origin permitido. Con * configurado, permitir y reflejar el Origin recibido como hoy; conservar Vary:Origin donde corresponda; no habilitar credentials |
| Origin permitido | Misma respuesta health y Access-Control-Allow-Origin para ese origen |
| Preflight permitido | OPTIONS actual=204 sin body y mismos headers/métodos permitidos por cors; no endurecer o añadir opciones incidentalmente |
| Origin denegado |403 con {"error":"Origin not allowed by CORS"}, sin Access-Control-Allow-Origin |
| Error interno sin statusCode |500 con {"error":"Internal server error"}; conservar console.error interno y ocultación del diagnóstico al cliente |
| Handler de error | Mantener cuatro parámetros y semántica statusCode??500; sin nueva coerción/validación de errores que cambie comportamiento ni envoltorio uniforme |
| Rutas/métodos inexistentes |404 HTML de Express, incluidos GET /missing y POST /health; no añadir middleware404 JSON |
| Arranque | PORT obtenido con Number.parseInt(process.env.PORT??'3000',10); preservar PORT0 y fallo existente ante configuración inválida, sin fallback nuevo a3000 |
| Carga de entorno | Dev/start conservan --env-file-if-exists=.env antes de importar app; misma prioridad de env del proceso. Tests no cargan .env mediante su script |
| Importar app | No escucha ni mantiene un servidor abierto por sí solo; createApp sigue permitiendo configuración aislada para pruebas |

Preservar también las rutas negativas y defaults actuales de Express/CORS. No cambiar a error.code/message, agregar parser JSON, rate limiting, logs con request ID o seguridad funcional nueva dentro de esta conversión. El formato objetivo permanece vigente para BE-08; conservar el legacy durante BE-05.1 es un alcance transitorio que el equipo debe aceptar, no una derogación de la especificación.

## 6. Criterios de aceptación y validaciones locales futuras

Los criterios siguientes definen la aceptación; la evidencia local obtenida está en §13. No equivalen a cierre global: Preview, verificación Linux y revisión/integración siguen pendientes. Las pruebas previas de BE-05.0 por sí solas no acreditan la migración.

| ID | Prueba verificable | Resultado requerido / evidencia |
|---|---|---|
| CA01 | Instalar solo versiones aprobadas en checkout aislado, revisar diff y reproducir con npm ci | Lock coherente; sin upgrades runtime incidentales ni secretos; no se requiere Atlas |
| CA02 | npm run typecheck y npm run build desde estado sin artefactos previos | Exit0; strict sin errores ni any/ts-ignore propios para eludirlos; emisión esperada en dist/src/app.js y dist/scripts/start.js |
| CA03 | Probar imports/export de app compilada | createApp/default disponibles, Node ESM resuelve .js y la importación no abre puerto |
| CA04 | npm test contra dist | Las cinco pruebas anteriores permanecen y aprueban; mantener assertions y cierre de puerto. Registrar total real si se agregan regresiones |
| CA05 | GET/HEAD health y rutas negativas | Cumplimiento de §5:200 JSON/body vacío;404 HTML para desconocidas/POST health; sin rutas de negocio nuevas |
| CA06 | Allowlist, sin Origin, wildcard, rechazado y OPTIONS | Status/body/headers de §5 equivalentes al baseline; sin credentials nuevas. Incluir separación/trim de la lista |
| CA07 | Error interno sintético sobre factory en memoria |500 legacy exacto, sin stack en cliente y diagnóstico interno;403 CORS preservado. No agregar endpoint de fallo a src |
| CA08 | npm run dev junto con npm run dev:build | Arranque inicial, recompilación y reinicio al modificar TS; error visible y rechazo de build final ante fallo. Cerrar únicamente los procesos propios |
| CA09 | Build y luego npm start con Node y dependencias runtime | Health/CORS operativos sin depender de tsc/tsx en ejecución. Ejercitar puerto efímero y default de manera aislada; registrar fallo ante PORT inválido |
| CA10 | Entorno sintético, .env ausente y fixture de entorno opcional | Misma carga/prioridad sin cambiar .env o variables persistentes del proyecto; no usar credenciales reales ni incorporar fixtures secretos |
| CA11 | Reproducir en Windows y entorno Linux de build/Preview | Imports con mayúsculas correctas, scripts ejecutables y paths consistentes; no depender de shell POSIX para desarrollar |
| CA12 | Revisión del diff final | Solo inventario §3; sin dist versionado, referencias locales, fuentes JS duplicadas, nuevos endpoints, conexión DB o cambios a PR #2/#3/#4 |

No hay un número fijo inventado de pruebas futuras: conservar las cinco existentes, añadir bordes relevantes y registrar cuántas se ejecutaron. BE-05.2 añade un segundo archivo para comprobar aislamiento y descubrimiento automático, según la corrección registrada en §14. Las observaciones en memoria de BE-05.0 no son tests TypeScript ni resultados de CA01–12.

## 7. Validación Preview pendiente y control de autorizaciones

**Estado: NO EJECUTADA.** El soporte documental de src/app.ts descrito en BE-05.0 es la base de diseño; no certifica la configuración efectiva del proyecto universitario.

La aprobación para implementar localmente no habilita por sí sola un deploy, una publicación Git, una promoción a producción ni cambios del dashboard. Antes de un push futuro, revisar si el enlace Git/Vercel disparará despliegues automáticos y obtener autorización para ese efecto. No ejecutar npx vercel, vercel build, pull de variables o comandos de deploy sin alcance/autorización correspondientes; tampoco descargar CLI implícitamente ahora.

Procedimiento posterior a autorizar un Preview concreto:

1. Identificar cuenta/proyecto universitarios, rama/commit, entorno Preview, responsable y autorización registrada. Confirmar qué despliegue previo verificado permite recuperación; no asumir que origin/dev es producción.
2. Revisar en lectura configuración efectiva: root del repositorio, preset Express, Node24, build/install/output y posibles overrides. Mantener vercel.json sin cambios previstos, con framework express/fluid:true.
3. Comprobar que la fuente detectada sea src/app.ts con import de Express/default export y sin listen; no configurar dist como salida estática ni asumir npm start como proceso serverless.
4. Verificar disponibilidad de devDependencies durante build, resultado de typecheck/build esperado y resolución de imports. La preparación de Function desde TS no sustituye las pruebas locales del JS emitido.
5. Ejecutar humo en la URL Preview: GET/HEAD health, OPTIONS y CORS permitido/rechazado, ruta inexistente y método negativo. Separar bloqueos de protección de plataforma de errores Express, sin desactivar protección para forzar un resultado.
6. Registrar URL, commit, logs seguros y resultados. Si falta autorización o falla la comprobación, mantener Preview pendiente y no declarar compatibilidad validada ni tarea Done.

Cualquier override/cambio de Vercel necesario requiere una propuesta adicional concreta y aprobada; no modificar producción por prueba/error. El cierre propuesto requiere evidencia Preview satisfactoria antes de integrar, sin autorización implícita de merge.

## 8. Riesgos y controles de parada

| Riesgo | Control / cuándo detener |
|---|---|
| Declaraciones incompatibles con Express5 o Node24 | Registrar versiones, compilar strict y revisar signatures, en particular Error.statusCode y callback CORS. No ampliar paquetes o relajar tipos para ocultar fallos |
| Cambio HTTP incidental al tipar | Tabla §5 y regresión contra compilado; preservar handler con aridad4 y defaults. Si exige otro comportamiento, detener y aprobar cambio de contrato separado |
| ESM válido solo con transpilador | NodeNext/imports .js y pruebas de dist; sin aliases exclusivos de bundler |
| Watch o build utilizan salida vieja | Build limpio y diagnóstico obligatorio; no aceptar health200 como prueba del código recién editado |
| Doble listener o carga tardía de env | App sin listen, arranque separado y flags antes de imports; tests con procesos/entorno aislados |
| Actualización accidental de runtime/lock | Comparar versiones resueltas y diff; instalar solo lo aprobado |
| Confundir soporte Vercel con deploy validado | Puerta independiente de autorización y evidencia de §7; no promover si falta Preview |
| Alcance crece hacia BE-06/07/08 | Inventario cerrado y exclusiones; detener y proponer ampliación antes de crear capas, persistencia o middleware funcional |

## 9. Reversión propuesta

Antes de implementar, registrar SHA base, diff y resultados del baseline en una rama/checkout aislados, sin descartar los dos documentos preparados. Conservar el estado anterior verificable y el lock original. La implementación y cualquier commit/publicación necesitarán su autorización; aquí no se ejecutan.

Antes de integración: si falla typecheck/build/test, corregir en la rama o reconstruir baseline en un checkout aislado, preservando diff para revisión. No usar reset/clean destructivos sobre trabajo compartido ni force push. Para reproducir baseline, fuentes/scripts/lock originales y npm ci solo en el trabajo posteriormente autorizado.

Tras integración: preparar revert de la migración mediante PR, conservando commits ajenos y restaurando los archivos originales, scripts, import de prueba, lock y documentación afectados. Ejecutar regresión antes de integrar la reversión. Limpiar dist solo con ruta exacta verificada; no borrar referencias locales ni datos de otros proyectos.

Si falla un deployment autorizado, usar únicamente el mecanismo de rollback de Vercel previamente autorizado hacia el deployment verificado y luego reconciliar Git por PR. No cambiar tráfico, dashboard o producción sin esa autorización; la reversión técnica no implica permiso para ejecutarla. Ningún paso toca MongoDB ni credenciales laborales.

## 10. Decisiones para aprobar ahora y decisiones postergadas

| Momento | Decisiones |
|---|---|
| Ahora, antes de instalar/migrar | A01 alcance limitado y aceptación del mínimo del plan; A02 regresión legacy de §5; A03 Node24/ESM/separación y paths; A04 cuatro versiones dev, tsconfig/scripts y dos terminales; A05 estrategia Vercel y puerta Preview separada; A06 aceptación/reversión y criterio de cierre |
| BE-06 y funcionalidades posteriores | Capas por recurso, DTOs de negocio y mappers, modelo físico/IDs Atlas, Zod/Mongoose, Google/sesión/tenant, error uniforme/logging/seguridad y cambio de runner cuando corresponda |
| Antes de BE-12/13 según consumidor | Unidad original/destino, humedad/VWC, especie/método de nutrientes, precisión y adquisición/recepción, snapshot parcial, series históricas/duplicados. Calibraciones/derivados opcionales pueden esperar si esa función queda fuera del alcance |

La aceptación de este contrato no aprueba los Draft BE-02/03/04, no resuelve sus pendientes y no permite exponer datos de clientes sin autenticación y aislamiento. Tampoco habilita reorganizar el plan o marcar BE-05 completa por instalar TypeScript. El DoD exige revisión, integración y pruebas correspondientes al alcance realmente implementado.

## 11. Registro de autorización y estado de revisión

**Evidencia:** decisión técnica comunicada por el usuario y respuesta explícita «Ejecutar la migración local BE-05.1»,16/11/2026, en esta conversación. Autoriza trabajo local e instalación de cuatro devDependencies; no se inventan revisores, actas o aprobación de despliegues.

| Acuerdo | Decisión: pendiente / aprobado / rechazado | Responsable y fecha | Evidencia o condiciones |
|---|---|---|---|
| A01 Alcance y mínimo del plan | Confirmado para migración local | Usuario,16/11/2026 | Decisión y autorización de ejecución local; no cierra BE-02/03/04 |
| A02 Contrato de regresión HTTP/entorno | Condición confirmada; pruebas locales aprobadas | Usuario,16/11/2026 | Preservar comportamiento y demostrarlo mediante compilación, pruebas y HTTP |
| A03 Node24, ESM, separación y paths | Dirección confirmada; detalles aplicados según contrato | Usuario,16/11/2026 | Node24, Express5 y arquitectura existente; se conservó ESM/separación |
| A04 Cuatro versiones dev, configuración y scripts | Instalación autorizada y realizada | Usuario,16/11/2026 | Versiones exactas seleccionadas técnicamente, registradas en §4; sin paquetes directos adicionales |
| A05 Diseño Vercel y criterio Preview | Compatibilidad prevista; Preview pendiente | Usuario,16/11/2026 | Requiere entorno autorizado posterior; no se desplegó ni modificó Vercel |
| A06 Aceptación, riesgos y reversión | Verificación local realizada; plan documentado | Registro técnico local,16/11/2026 | Sin revisión independiente registrada ni autorización para rollback, merge o publicación |

- [x] Usuario autoriza explícitamente ejecutar la implementación local limitada, sin funcionalidades nuevas.
- [x] Cuatro versiones exactas seleccionadas e instaladas bajo esa autorización; lock/runtime verificados.
- [x] Validaciones locales ejecutadas con resultados en §13.
- [ ] Revisión independiente del equipo y aprobación de integración: pendientes.
- [ ] Se autorizó, por separado, el eventual push/Preview y su efecto automático en Vercel; rama/commit/entorno/responsable: no registrados.
- [ ] Preview ejecutado y aprobado con evidencia: pendiente.
- [ ] Revisión/integración y criterios de Done satisfechos: pendientes.

La ejecución local autorizada ya se realizó. Publicación, Preview e integración conservan su frontera de autorización separada y no se ejecutan automáticamente.

## 12. Validación de la preparación documental — registro previo a implementar

Se contrastaron alcance, scripts y criterios con BE-05.0, el plan y los archivos actuales. Verificación documental ejecutada: enlaces locales resueltos, bloque JSON de seis scripts parseable e idéntico al de BE-05.0, cuatro dependencias, doce criterios de aceptación y seis acuerdos pendientes presentes; sin casillas de aprobación marcadas, caracteres de reemplazo ni espacios finales. git diff --check sin errores. Ninguna comprobación documental acredita los criterios de la implementación o el Preview.

Se confirmó por SHA256 que INFORME_BE05_PREPARACION_TYPESCRIPT.md permanece intacto; la rama se conserva y no hay diff de archivos versionados ni staged. El estado contiene únicamente este contrato nuevo y el informe previo ya existente sin seguimiento. No se repitió npm test en esta preparación exclusivamente documental; las cinco pruebas aprobadas registradas en BE-05.0 son evidencia del JS anterior, no resultados de la migración.

No se migró código, instalaron paquetes, cambiaron package.json/Vercel/entorno, crearon commits/PR, hizo push, modificaron otros repositorios ni inició BE-06.

## 13. Resultado local BE-05.1 —16/11/2026

El apartado12 conserva los resultados de la preparación documental anterior. Tras la autorización posterior se migraron src/app.js→src/app.ts y scripts/start.js→scripts/start.ts, se creó tsconfig.json y se ajustaron package/lock, README y tests dentro del inventario. No se añadieron endpoints, capas de negocio, Mongo o normalizadores.

- Baseline previo:5/5 pruebas JavaScript aprobadas.
- npm ci --ignore-scripts --no-audit --no-fund: instalación reproducible satisfactoria. Solo cuatro devDependencies directas y sus transitivas de desarrollo; Express5.3.0/cors2.8.6 y todas las entradas runtime originales del lock intactas.
- npm run typecheck y build aprobados. Un build limpio reconstruyó los dos JS esperados después de retirar únicamente sus artefactos generados; strict sin relajación ni any/ts-ignore propios.
- npm test:16/16 aprobadas,0 fallos; cinco originales y11 adicionales de headers/HEAD/rutas negativas, wildcard/allowlist,500/logging, import sin listener, arranque del módulo compilado, .env sintético/prioridad y PORT inválido. Fixtures temporales fuera del proyecto, sin editar .env ni entorno persistente.
- npm run dev, tsc watch y npm start ejecutados con health200. Error de tipos sintético temporal: TS2322 visible, sin JS nuevo y última versión válida operativa. Fuente restaurada exactamente, recompilación y reinicio Node correctos; no quedó error de tipos en el código.
- Procesos de prueba cerrados. Los watchers requirieron permisos del sistema: se identificaron y cerraron exclusivamente sus PID/árboles propios, sin detener procesos de otros proyectos.
- vercel.json, .env.example, .gitignore y el informe BE-05.0 conservados. dist y documentacion-referencia/ excluidos; sin cambios de otras ramas/repositorios o credenciales laborales.

No se ejecutó Preview/deploy ni se verificó Linux/Vercel real. Default y parseo PORT preservados en fuente; ensayos de escucha con puertos de prueba, incluido PORT0. Sin pruebas Atlas, OAuth, DTOs de negocio, Zod o normalización. BE-05 sigue sin revisión/integración y no está Done. No hubo commit, push o PR.

## 14. Actualización de auditoría BE-05.2

El resultado16/16 de §13 es histórico de BE-05.1. La auditoría detectó que fijar un único archivo en npm test reducía el descubrimiento automático del comando JS original. Se corrigió el script a build seguido de node --test y se añadió test/app-isolation.test.js como regresión en otro archivo. También se añadió una prueba de coincidencia exacta de Origin; no se cambió la lógica HTTP de src/app.ts.

Resultado actualizado:18/18 pruebas aprobadas; npm ci, typecheck/build y13 escenarios de comparación HTTP anterior/posterior satisfactorios. En temporal aislado se verificaron build limpio, dev/watch/restart y arranque con npm ci --omit=dev sin compilador, fuentes TS ni tsconfig. El build sí requiere las devDependencies en su fase de compilación; el runtime no. Preview y revisión/integración permanecen pendientes. Evidencia, hallazgos y límites completos en [INFORME_BE05_AUDITORIA_TYPESCRIPT.md](INFORME_BE05_AUDITORIA_TYPESCRIPT.md).
