# BE-05.0 — Evaluación de migración limitada a TypeScript

**Fecha:** 16/11/2026. **Estado:** evaluación documental; BE-05 no implementada. Único entregable: este informe. No se instalaron paquetes, migraron archivos, cambiaron variables, configuró Vercel ni iniciaron BE-06 u otras funcionalidades.

## 1. Resumen ejecutivo

**Es técnicamente viable iniciar parcialmente BE-05 con una migración limitada del esqueleto existente, una vez aprobado el contrato técnico mínimo de §7.** No hace falta resolver Atlas, Google, NPK, VWC o todas las decisiones de los PR Draft para convertir los dos archivos de aplicación sin añadir capacidades. La aceptación del mínimo exigido por el plan sí sigue pendiente; la viabilidad no equivale a autorización de implementación ni a aprobación de los PR #2/#3/#4.

Recomendación principal: conversión controlada de `src/app.js` y `scripts/start.js` a TypeScript, conservando su separación, ESM y lógica; `tsc` como comprobador y emisor de JavaScript; Node para desarrollo/arranque del compilado; cinco pruebas existentes conservadas con `node:test`, apuntando al compilado. Vercel mantendría la entrada fuente `src/app.ts` y su integración Express. No se crea un backend nuevo, otro framework, un bundle propio ni capas de negocio vacías.

Los bloqueos reales son aprobar ese alcance/contrato de regresión, la estrategia ESM/build/rutas, las dependencias de desarrollo y la verificación posterior de Preview. No se ha probado todavía un compilador, un servidor TypeScript ni un despliegue de esta propuesta.

## 2. Git, fuentes y límites

Antes de trabajar: árbol limpio en feature/be-04-catalogo-unidades; origin `https://github.com/Proyecto-Agro-Org/be-agro.git`; identidad local Camila Gonzalez / camiiigonzalez1503@gmail.com. Se ejecutó fetch origin con selección de cuenta universitaria y se creó `feature/be-05-preparacion-typescript` desde origin/dev, en `1bb20f76b7a739f42c75b37b9a64315276560ec1`. La rama nueva no existía. No se cambia configuración Git global ni credenciales.

Se conserva esa base y no se incorporan los commits exclusivos BE-02 `28556ff485f2a9f2f2239c0a612ac623dc33fdef`, BE-03 `c2a4b3175eef12b91e0d1e554082b4d281cdbe55` o BE-04 `b2deb9bb2b11adbf5f96e81d3a418a72c6492c96`. main/dev y las ramas de esos PR no se modifican.

Fuentes locales leídas: [plan](IMPLEMENTATION_PLAN.md), [especificación](ESPECIFICACION.md), [instrucciones](AGENTS.md), [DoD](DEFINITION_OF_DONE.md), [auditoría inicial](INFORME_BE00_BE01.md), [README](README.md), package/lock, vercel.json, .env.example, .gitignore y los tres JS versionados de aplicación/pruebas. Se releyeron los apartados de etapa2, contrato mínimo, pruebas y aislamiento del Plan_Trabajo_Backend_A26T02 (1).docx mediante su extracto local en documentacion-referencia. Esa carpeta continúa excluida; no se copia al entregable. El plan desglosa en BE-05/06/07/08 responsabilidades que la fuente Word agrupa en etapa2: no se atribuyen a BE-05 automáticamente Zod, Mongoose, capas o errores uniformes.

Consultas remotas de solo lectura:

| PR | Estado comprobado | Referencia usada / implicación |
|---|---|---|
| [#2 — BE-02](https://github.com/Proyecto-Agro-Org/be-agro/pull/2) | Abierto, Draft, sin fusionar; head28556ff | Informe: modelo propuesto y acceso Atlas bloqueado; impide aprobar persistencia/IDs físicos, no tipar health |
| [#3 — BE-03](https://github.com/Proyecto-Agro-Org/be-agro/pull/3) | Abierto, Draft, sin fusionar; headc2a4b31 | DTO/Zod documental, error objetivo y D03-14 pendientes; no copiar contratos de negocio ni ejecutar sus ejemplos como código aprobado |
| [#4 — BE-04](https://github.com/Proyecto-Agro-Org/be-agro/pull/4) | Abierto, Draft, sin fusionar; headb2deb9b | Decisiones por etapa: migración de infraestructura no depende individualmente de calibración; aceptación del mínimo sigue abierta |

Los estados antiguos de documentos base («solo main», «sin PR», etc.) describen sus auditorías originales. No se actualizan en esta tarea ni se usan para negar el estado remoto actual. No se accedió a Atlas, frontend, ingesta ejecutable, dashboard de Vercel o credenciales de producción.

## 3. Estado técnico comprobado

| Elemento | Observación directa | Límite / consecuencia |
|---|---|---|
| Node/npm locales | Node v24.19.0 y npm11.17.0; engines.node=24.x | Conservar major24; no inferir patch del runtime desplegado |
| Módulos | package.type=module, imports/exports ESM | Mantener ESM; evitar conversión a CommonJS o imports sin extensión compatibles solo con bundler |
| Dependencias | package express ^5.1.0/cors ^2.8.6; lock e instalación express5.3.0/cors2.8.6 | Sin devDependencies. No actualizar versiones HTTP durante migración; comparar diff del lock |
| Compatibilidad instalada | engines de express instalado >=18; cors >=0.10; Node24 satisface ambos | No se halló incompatibilidad runtime que exija reemplazar Express/CORS. Esto no certifica compatibilidad futura de todas las declaraciones TypeScript |
| Tipos/herramientas | No están typescript, @types/node, @types/express, @types/cors, tsx ni Vercel CLI como módulos locales | No se ejecutan tsc/tsx/vercel build. No usar npx para descargarlos implícitamente |
| App | src/app.js importa express/cors; createApp configurable y default app | Importar el módulo crea app, no abre puerto; ya favorece tests/despliegue |
| Arranque | scripts/start.js importa app y hace listen | Separación app/server ya existe; no hace falta crear src/server.ts por estética |
| Ruta | GET /health,200 JSON {status:"ok"}; sin consultas DB | Health de proceso, no readiness. HEAD /health automático de Express responde200 sin body |
| CORS | Set de CORS_ORIGINS separado por coma, trim, sin vacíos; matching exacto; sin Origin o con * se permite | * refleja el Origin, no literal * en el header; mantener Vary. Sin credentials configuradas |
| Rechazo CORS | Error con statusCode403; body {error:"Origin not allowed by CORS"} | No cambiar a error.code/message durante BE-05 |
| Error común | Handler de cuatro parámetros; statusCode ??500;500 registra console.error y devuelve {error:"Internal server error"} | No hay logger/redacción nueva ni error de dominio. Mantener aridad4 y comportamiento, no afirmar que un tipo TS valida errores en runtime |
| Ruta/método no registrado | Express devuelve404 HTML; POST /health no es endpoint registrado | No agregar notFound JSON, parser body, prefijo /api/v1 ni negocio |
| Entorno | dev/start usan --env-file-if-exists=.env; CORS_ORIGINS y PORT; parseInt(PORT??'3000',10) | Carga previa a importar app; tests no cargan .env por script. No añadir dotenv/Zod, defaults o coerciones diferentes |
| Vercel | vercel.json: framework express, fluid true; README declara detección de src/app.js | Configuración leída; deploy, overrides y variables remotos no comprobados |
| Pruebas | test/health.test.js usa node:test/assert/fetch y puerto efímero127.0.0.1 | Cinco pruebas, sin Vitest/Supertest; no migrar runner en este alcance |
| Estructura | src/app.js, scripts/start.js, test/health.test.js; resto son configuración/documentación | Tres JS versionados: dos de aplicación a convertir, prueba JS a conservar/adaptar |

Scripts actuales, leídos sin modificarlos:

```json
{
  "dev": "node --env-file-if-exists=.env --watch scripts/start.js",
  "start": "node --env-file-if-exists=.env scripts/start.js",
  "test": "node --test"
}
```

No hay script build/typecheck/lint, parser JSON explícito, auth, Mongoose, sesión, endpoints de negocio ni normalizadores. `.gitignore` ya excluye dist, node_modules, .env/.env.*, permite .env.example y excluye .vercel; no requiere cambio por esta propuesta.

## 4. Evaluación individual de dependencias

«No bloquea» significa ausencia de dependencia técnica con convertir lo existente. No elimina el requisito del plan de aprobar un mínimo ni autoriza funcionalidades posteriores.

| Dependencia | ¿Bloquea la migración limitada? | Justificación / qué se posterga | Decisión mínima del equipo |
|---|---|---|---|
| 1 Modelo físico Atlas | No | No hay imports/consultas Mongo que convertir; modelos e índices pertenecen a etapas siguientes | Aprobar que BE-05 no introduce persistencia ni schema candidato; BE-02 sigue pendiente |
| 2 clientid/device_id/_id | No | Ningún handler actual usa esos IDs | Postergar sus tipos y correlación; no crear alias ni tipos BSON ficticios |
| 3 DTOs definitivos | No para negocio; sí delimitar la superficie actual | Health ya tiene contrato concreto y no recibe entrada de negocio; no exige congelar todos los DTOs Draft | Aprobar conservar health/errores legacy y no copiar DTO/Zod de PR #3; interfaces locales técnicas no son contrato nuevo |
| 4 Google | No | No hay auth implementada ni código Google que migrar | Excluir OAuth, login real y SDKs |
| 5 Sesión/aislamiento | No para health público; sí antes de exponer negocio | No se sirve información de clientes ni se crean consultas | Mantener health público y excluir rutas privadas/tenant; no confundir CORS con auth |
| 6 Contrato HTTP de error | Sí aprobar preservación, no resolver el objetivo futuro | Uniformar error o404 introduciría cambios funcionales | Aceptar temporalmente error string y404 HTML como regresión; transición a objeto queda BE-08/coordinación FE |
| 7 Unidades | No | Sin lecturas ni mapper actual | No fijar enum de unidades ni nuevas respuestas; acuerdo antes de BE-12/13 |
| 8 Calibración humedad | No | No se calcula VWC ni se publica humedad | Mantenerla pendiente de IoT/Agronomía |
| 9 Normalización | No | No hay conversor existente que compilar | No implementar parsers ni timestamps de telemetría; BE-04 debe cerrarse para sus consumidores |
| 10 Capas | Sí acotar estructura | App ya separada de listen. Reorganizar módulos introduce cambios/riesgos ajenos a una conversión corta | Conservar los dos módulos; extracción MVC completa/carpetas corresponde BE-06; no crear stubs vacíos |
| 11 Vercel | Sí como diseño y prueba de cierre | Debe seguir detectando la app y compilar sin cambiar rutas. El dashboard efectivo no se verificó | Aprobar fuente src/app.ts y Preview posterior; comprobar root/build/output/Node sin asumir overrides |
| 12 Compilar/arrancar Node | Sí | Son el núcleo de BE-05; ESM y paths deben resolver realmente | Aprobar tsc/tsconfig, dev/start/test, versiones de tipos/toolchain y artefactos dist |

Ninguna cuestión agronómica o física exige bloquear por sí sola el compilador. Los PR Draft tampoco pueden usarse como aprobación de mínimo ya otorgada. Ver §7 para la frontera propuesta A/B/C.

## 5. Comparación de estrategias

| Alternativa | Complejidad / dependencias | Riesgo y pruebas | Evaluación |
|---|---|---|---|
| Incremental JS+TS, allowJs/checkJs/JSDoc | Útil en repos grandes; agrega estado mixto y decisiones de emisión | Puede dejar código fuera del chequeo o dos fuentes equivalentes | Poco beneficio con solo dos módulos de aplicación; no recomendada como estrategia principal |
| Conversión controlada de dos módulos, tsc→JS, Node ejecuta dist | Cuatro devDependencies propuestas; sin runner adicional | Tests del compilado y arranque de producción comprueban imports reales; dev requiere dos procesos de vigilancia | **Principal recomendada** por alcance pequeño y dependencias mínimas |
| tsc para chequeo/emisión y tsx en dev | Suma tsx como quinta devDependency | Dev más cómodo; ejecución de fuente no reemplaza tests del compilado | Alternativa válida si el equipo prioriza un proceso de dev; no necesaria para este mínimo |
| Type stripping nativo de Node y chequeo tsc aparte | Evita runner, pero impone subconjunto de sintaxis/resolución para ejecutar TS | Ejecutar no comprueba tipos; mayor diferencia entre rutas de fuente y compilado | No elegirlo como base aquí: no aporta ventaja al validar también JS emitido |
| Compilación nativa Vercel como único control | Menos pasos locales | Un despliegue que transpila no sustituye chequeo estricto ni prueba del start compilado | Complemento de despliegue, no estrategia única |

Node documenta que ejecutar TS nativo elimina tipos sin comprobarlos e ignora tsconfig; el ejemplo oficial de soporte ampliado usa tsx. Eso informa las alternativas, sin afirmar que tsx esté instalado o que su resolución se haya probado aquí. [Node24 — TypeScript](https://nodejs.org/docs/latest-v24.x/api/typescript.html).

## 6. Estrategia principal y herramientas propuestas

### Compilación y módulos

Proponer TypeScript con modo NodeNext, ESM y strict, sin cambio de major Node. Con rootDir `.` e include de src/scripts, se conserva la relación de imports en `dist/src/app.js` y `dist/scripts/start.js`. El import existente `../src/app.js` en el futuro scripts/start.ts apunta al JS emitido sin reescrituras heurísticas; no usar aliases paths o resolución bundler para ocultar errores de Node. [Guía oficial TypeScript para compilar y ejecutar en Node](https://www.typescriptlang.org/docs/handbook/modules/guides/choosing-compiler-options.html).

Opciones candidatas, no un archivo creado ni configuración compilada en esta evaluación:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": ".",
    "outDir": "dist",
    "strict": true,
    "noEmitOnError": true,
    "verbatimModuleSyntax": true,
    "esModuleInterop": true,
    "types": ["node"],
    "lib": ["ES2022"],
    "allowJs": false,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*.ts", "scripts/**/*.ts"],
  "exclude": ["node_modules", "dist", "test", "documentacion-referencia"]
}
```

noEmitOnError evita generar una salida nueva con errores; no limpia dist previo. Antes de aceptación/CI, usar checkout limpio o limpiar exclusivamente dist de forma controlada para no confundir una salida vieja con build aprobado. No añadir rm -rf ni borrados generales a scripts multiplataforma por conveniencia. [TypeScript — noEmitOnError](https://www.typescriptlang.org/tsconfig/noEmitOnError.html).

### Dependencias

**Runtime nuevas:0. Dev nuevas:4**, a instalar solo en BE-05 autorizado:

- typescript: compilador; elegir/fijar versión estable compatible al implementar, sin asumir que «última» ya se ensayó.
- @types/node: línea compatible con Node24, sin introducir APIs exclusivas de otra major.
- @types/express: línea5 compatible con Express5; no usar4 por defecto.
- @types/cors: declaraciones del paquete cors utilizado.

Express/cors instalados no declaran types/typings en sus package.json; se verificó esa necesidad de declaraciones separadas. No se inspeccionó ni compiló todavía una versión concreta de @types. Bloquear el PR de implementación si sus tipos no pasan strict, en vez de añadir any/ts-ignore para ocultarlo. Tipos de terceros pueden contener any en sus propias firmas; la regla del proyecto es no introducirlo para eludir contratos propios.

Sin ts-node, tsx, nodemon, concurrently, cross-env, dotenv, bundler, Vitest, Supertest, Zod o Mongoose en la estrategia mínima. Vitest/Supertest siguen previstos para etapas de testing posteriores; conservar node:test evita mezclar cambio de runner con migración de lenguaje. El coste aceptado por cuatro devDependencies es usar dos terminales para watch, no un supervisor nuevo.

Scripts candidatos para revisión, **no aplicados ni ejecutados**:

```json
{
  "typecheck": "tsc -p tsconfig.json --noEmit",
  "build": "tsc -p tsconfig.json",
  "dev:build": "tsc -p tsconfig.json --watch --preserveWatchOutput",
  "dev": "npm run build && node --env-file-if-exists=.env --watch dist/scripts/start.js",
  "start": "node --env-file-if-exists=.env dist/scripts/start.js",
  "test": "npm run build && node --test test/health.test.js"
}
```

Flujo: terminal1 `npm run dev` hace build inicial y abre Node watch; terminal2 `npm run dev:build` recompila cambios TS. Node observa JS emitido. Si tsc falla, puede seguir sirviéndose la última compilación válida: no interpretar un health200 como typecheck aprobado; consultar diagnóstico y exigir build limpio. Cambio en .env requiere reiniciar, como política explícita de dev; no prometer que watch vigila ese archivo. El start de producción exige build previo y ejecuta solo JS. Tests siguen sin `--env-file-if-exists` y deben usar configuración sintética/puerto efímero.

## 7. Contrato técnico mínimo propuesto A/B/C

**A — indispensable antes de implementar BE-05:**

| ID | Acuerdo a aprobar | Cierre verificable |
|---|---|---|
| A01 | BE-05 limitado al código Express existente; sin modelos, DTOs de negocio, auth, normalizadores ni BE-06 | Registrar revisión del equipo/Issue o PR que acepte este mínimo como entrada del plan; no exigir integrar todos los Draft ni declarar sus decisiones aprobadas |
| A02 | Preservar exactamente contrato actual, incluidos errores legacy y404 | Cinco tests siguen y se agregan regresiones justificadas en test/health.test.js; no uniforme error.code/message ni validación de env en este alcance |
| A03 | Mantener Node24/ESM, Express/CORS y separación app/start | Paths emitidos y scripts de §6 aprobados; .env antes de imports, PORT y CORS sin nuevas reglas |
| A04 | Cuatro devDependencies y tsconfig estricto, pruebas del compilado, desarrollo en dos terminales | Autorizar instalación futura, revisar versiones/lock y scripts. No se instala nada en BE-05.0 |
| A05 | Mantener adaptación Express Vercel y exigir Preview antes de integrar | Identificar acceso universitario y entorno de prueba; revisar ajustes efectivos y resultado HTTP. No configurar ni desplegar producción durante evaluación |
| A06 | Reversión y criterio de Done | Build/arranque/tests/Preview aprobados antes de integrar; revert por PR si hay regresión, sin reescribir ramas compartidas |

A01 concreta la propuesta de mínimo BE-02/03/04: no usar sus partes no aprobadas en el código de infraestructura y mantenerlas pendientes para sus etapas. Debe aceptarlo el equipo; este informe no cambia IMPLEMENTATION_PLAN.md ni AGENTS.md. La solicitud actual autoriza evaluación, no esas instalaciones ni migración.

**B — antes de modelos, sesión o endpoints posteriores:** inventario/tipos/relaciones y aliases BE-02; política de Google/sesión y aislamiento; contrato FE/BE de rutas/DTOs/errores; validación Zod, Mongoose y repositorios. La arquitectura MVC vigente se respeta al implementarlos en BE-06 y siguientes. No abrir rutas privadas basadas en IDs propuestos o tenant de navegador.

**C — antes de los consumidores de BE-12/13, según función:** unidades conocidas, semántica de humedad, fecha de adquisición/recepción, precisión/calidad, snapshot parcial, históricos comparables y política de duplicados. Calibración VWC y ensayos NPK solo bloquean exponer esas magnitudes como tales; derivados opcionales o enum ampliado pueden postergarse si quedan fuera de alcance. No reemplazar datos faltantes con cero ni usar Date como solución submilisegundo por haber migrado a TS.

## 8. Inventario exacto del cambio futuro propuesto

Este inventario es un plan para otro trabajo autorizado. **En BE-05.0 solo se crea este informe.**

| Acción futura | Archivos | Detalle / validación |
|---|---|---|
| Crear | tsconfig.json | Configuración candidata §6; no más configs de test/build sin necesidad demostrada |
| Migrar/renombrar | src/app.js → src/app.ts | Mismas exports createApp/default, orden middleware, health y errores; tipar opciones, callback y error con tipos locales, sin reglas runtime nuevas |
| Migrar/renombrar | scripts/start.js → scripts/start.ts | Mismo parseInt/default PORT, import ../src/app.js y listen/log. Se conserva ruta scripts, no se crea segundo servidor |
| Modificar | package.json | DevDependencies y scripts de §6; type=module y engines24.x se conservan; runtime deps no se actualizan |
| Modificar | package-lock.json | Solo resolución coherente de cuatro devDependencies y transitivas; diff revisado, sin upgrades incidentales |
| Modificar | test/health.test.js | Importar createApp desde ../dist/src/app.js. Conservar las cinco pruebas/assertions y lifecycle; ampliar regresiones de superficie existente, sin endpoints ficticios en src |
| Modificar | README.md | Documentar npm ci/build/start, dos terminales dev, fuente Vercel, restricciones y resultados; no presentarlo como backend de negocio |
| Conservar | vercel.json | Mantener framework express y fluid:true; sin outputDirectory dist, rewrites o builds legados |
| Conservar | .env.example, .gitignore | Misma variable CORS_ORIGINS, sin agregar secretos ni default nuevo; dist ya excluido |
| Conservar | AGENTS.md, ESPECIFICACION.md, IMPLEMENTATION_PLAN.md, DEFINITION_OF_DONE.md, INFORME_BE00_BE01.md, SCHEMA_PROPUESTA.md, ddbb.puml y este informe | Sin reescribir acuerdos ni actualizar Done antes de integrar; si la revisión exige un cambio de contrato, acordarlo y ampliar inventario antes de hacerlo |
| Conservar fuera de rama | Ramas y documentos exclusivos de PR #2/#3/#4; documentacion-referencia/ local | No merge/cherry-pick/copia automática ni staging de referencias |
| Generar localmente, no versionar | dist/src/app.js, dist/scripts/start.js | Resultado tsc; no fuente alternativa ni carpeta estática Vercel |
| Eliminar | Ninguno de forma independiente | Solo desaparecen los paths JS originales por renombre; no mantener versiones JS/TS paralelas ni borrar trabajo del equipo |

No hace falta crear api/index.ts, src/server.ts, DTOs productivos, models, adapters, carpetas vacías o archivos de normalización. El esquema de referencia permite evolucionar responsabilidades: ya hay separación de app/server aunque el listener viva en scripts. Mantenerlo reduce cambios y sigue permitiendo extracción en BE-06.

## 9. Riesgos y compatibilidad

| Riesgo | Medida concreta / criterio de parada |
|---|---|
| Tipos Express5 incompatibles o inferencia de Error.statusCode | Tipos locales explícitos/estrechamiento o aserción acotada, sin any/ts-ignore propio. No añadir coerción/validación que cambie errores observables; mantener handler con cuatro parámetros. Fallo de strict bloquea entrega |
| ESM funciona en dev pero falla compilado | Imports relativos .js, NodeNext y test contra dist; no usar paths sin resolución runtime |
| app escucha al importarse o dos listeners | Conservar app sin listen y start separado; importar app en prueba no ocupa puerto; solo start abre puerto |
| .env/CORS evaluados en orden diferente | Cargar env por flag de Node antes de importar default app; conservar createApp configurable; no nueva validación startup o env global cambiada por tests |
| Cambiar reglas PORT por tiparlas | Conservar parseInt y default, incluido PORT0; no reemplazar por Number/validación Zod. Invalid PORT no se convierte silenciosamente en3000 |
| Actualizar lock/deps HTTP sin necesidad | Conservar versiones runtime y revisar diff. No mezclar auditoría/upgrade de seguridad no solicitado con esta conversión |
| Compilado obsoleto o doble fuente detectada | Build limpio y búsqueda de archivos JS fuente sobrantes; dist excluido. Watch con errores no prueba versión nueva válida |
| Mayor reorganización que migración | Inventario §8 cerrado; extracción de capas y nuevo error handler quedan fuera |
| Tests pasan solo en desarrollo | Ejecutar suite contra dist y start con Node sin compilador disponible en runtime; validar Preview por separado |
| Vercel ignora settings esperados o cambia build al añadir script | Revisar comandos/overrides/log de build y la entrada efectiva en Preview; no asumir npm start como mecanismo serverless |

No se observó dependencia binaria o herramienta runtime que obligue a abandonar TypeScript; la compatibilidad concreta de declaraciones y compilador sigue **sin comprobar** hasta instalación autorizada. Tests existentes no son garantía completa de equivalencia en todas las entradas posibles; ampliar bordes relevantes evita declarar igualdad por simple renombre.

## 10. Compatibilidad Vercel propuesta

Vercel documenta `src/app.ts` con import de Express y default export como entrada admitida, empaquetada como Function con Fluid. La propuesta conserva esa frontera fuente; **dist no se configura como salida estática ni como entrada implícita**. La importación de app no abre puerto. Estos son soporte documentado e inferencia de diseño, no evidencia de que el proyecto actual ya se haya desplegado correctamente con TS. [Express en Vercel](https://vercel.com/docs/frameworks/backend/express).

Se conserva engines24.x; Vercel admite esa major y actualiza versiones menores/parches, por lo que no se asume igualdad exacta con Node24.19.0 local. Comprobar major efectiva en logs de build/runtime durante Preview, sin agregar ruta de diagnóstico. [Versiones Node de Vercel](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions).

La compilación tsc previa es evidencia local/CI del artefacto Node; Vercel puede preparar su propia Function desde fuente TS. No se sustituye el adaptador por un servidor permanente ni se presupone que use dist o npm start. Añadir build a package puede afectar el proceso efectivo según preset/overrides: comprobar en Preview que corre el chequeo esperado y no depende de artefactos versionados. La instalación de devDependencies de compilación debe estar disponible en fase build, aunque el runtime solo necesite express/cors. Mantener root del repo y no imponer outputDirectory. [Ajustes de build Vercel](https://vercel.com/docs/builds/configure-a-build).

Prueba pendiente, fuera de BE-05.0: build/log de detección y deploy Preview autorizado, humo HTTP/CORS, rutas negativas y rollback conocido. Si requiere override distinto del plan, detener integración y presentar el cambio concreto para aprobación, sin adaptar producción por ensayo/error. No se necesita ninguna credencial Atlas; el acceso Vercel universitario sí deberá estar disponible para esa verificación.

## 11. Plan de implementación BE-05 — no ejecutado

| Paso | Archivos afectados | Validación | Riesgo/control |
|---|---|---|---|
| 1 Aprobar mínimo y fijar base | Referencia Git; acuerdos A01–06 | status limpio, origin/dev y baseline SHA; comparar alcance | No iniciar por inferencia de Draft |
| 2 Registrar regresión previa | test/health.test.js; captura de resultados, sin cambiar src | npm test y contrato §12 antes de migrar | No aceptar una línea base ya fallida |
| 3 Instalar cuatro devDeps aprobadas y configurar TS | package/lock, tsconfig.json | Diff, versiones/types Node24/Express5, typecheck sin instalar nada extra | No resolver fallos con runtime upgrade incidental |
| 4 Renombrar y tipar app | src/app.js→app.ts | Compilación; factory/default export y middleware iguales | Error.statusCode y aridad4; no nuevo handler/contrato |
| 5 Renombrar listener | scripts/start.js→start.ts | Emisión/import .js y separación del puerto | No mover a src/server además del rename ni abrir puerto desde app |
| 6 Ajustar scripts/tests/docs | package.json,test/health.test.js,README.md | Build previo, test import dist, flags env, dos terminales dev | Ninguna prueba exige producción ni .env real |
| 7 Build limpio y chequeo estático | dist generado, tsconfig | npm run typecheck; npm run build con salida nueva; imports resueltos | dist previo puede ocultar fallo; noEmitOnError solo evita nueva emisión |
| 8 Desarrollo y producción local | Artefactos/script, sin editar variables reales | Dev/watch y start desde root; reinicios; puerto de prueba y cierre del proceso propio | Dos watchers, compilado viejo, cwd/env |
| 9 Regresión HTTP y errores | test/health.test.js | Cinco pruebas anteriores más bordes de §12 sobre compilado | Evitar cambios de body/header/status disfrazados de tipos |
| 10 Compatibilidad del instalador/build | package-lock y artefactos en checkout aislado | npm ci en etapa autorizada, build/test/start reproducibles | Sin credentials de Atlas ni scripts E2E de ingesta |
| 11 Preview Vercel | Configuración verificada, sin cambios previstos en vercel.json | Source entry, build, Node24, humo/CORS/rutas negativas | Local pasa no demuestra despliegue; si falla, no promover |
| 12 Revisión y cierre | Diff de inventario, PR futuro | Sin rutas nuevas, secretos ni archivos de referencia; DoD aplicable y aprobación | No marcar Done por tsc o Preview aislados; no fusionar automáticamente |

## 12. Criterios de aceptación y pruebas necesarias

### Locales de la migración futura

1. Checkout limpio más instalación autorizada reproducen typecheck/build sin errores. Solo se generan dist/src/app.js y dist/scripts/start.js como artefactos de aplicación esperados; ninguna fuente JS duplicada ni TS ignorada por include.
2. npm test ejecuta las **cinco pruebas existentes** contra compilado y conserva sus resultados/assertions; se pueden añadir pruebas de bordes en el mismo test sin sustituir las anteriores.
3. GET /health=200, body exacto {"status":"ok"}, JSON y sin x-powered-by; HEAD=200/body vacío. No DB ni autenticación obligatoria añadidas.
4. Origin permitido=200/allow-origin correspondiente; no Origin=200; wildcard refleja Origin y Vary; Origin denegado=403/cuerpo legacy exacto/sin allow-origin; preflight permitido=204 y headers equivalentes. Mantener defaults cors y ausencia de credentials; no endurecer configuración incidentalmente.
5. GET desconocido y POST /health siguen404 con formato HTML de Express; no introducir /api/v1/health, login, rutas de negocio o 404 uniforme.
6. Fallo interno sintético en memoria verifica500 {"error":"Internal server error"} y logging existente; error CORS mantiene403. No devolver stack a cliente ni transformar handler en uno de3 argumentos.
7. Factory importable sin listen; listener corre desde dist con Node, incluyendo PORT0 sintético. Flag de .env opcional y prioridad de env de proceso conservados; ensayos de .env usan solo fixtures temporales fuera del proyecto/checkout aislado y sin editar variables persistentes ni cargar producción.
8. Dev recompila y reinicia al editar TS; fallo de compilación visible y build final rechazado aunque siga activo un proceso anterior. Start usa solo JS con dependencias runtime, sin requerir typescript/tsx en producción; no prometer build al ejecutar npm start por sí solo.
9. Root/case de imports, scripts y limpieza funcionan en Windows y entorno Linux de Vercel; package-lock sin upgrades runtime no planificados. Build de CI no debe arrancar servidor ni necesitar secretos.
10. Diff solo del inventario autorizado futuro; .env/example y configuración runtime conservados, sin secretos ni Mongo driver/models/consultas. Sin acceso a datos ni colecciones.

### Posteriores en Vercel

11. Preview con cuenta universitaria y configuración efectiva revisada; detección app.ts, build disponible, Node24 y Function sin dependencia de un dist versionado. No trasladar el listen local al arranque serverless por suposición.
12. Repetir humo health/CORS/OPTIONS/HEAD/ruta inexistente sobre Preview, distinguiendo protección de plataforma de respuesta de Express. Documentar URL/commit/logs seguros y rollback; nunca afirmar éxito por documentación de soporte solamente.

No es necesario probar Google, Atlas, DTOs de negocio o normalizadores para aceptar este alcance; sus DoD/QA aplican cuando se implementen las capacidades correspondientes. La migración no acredita su seguridad ni su funcionamiento.

## 13. Plan de reversión

Antes de implementar: registrar base integrada, diff limpio y resultados HTTP/tests; trabajar en rama propia y guardar cambios mediante flujo autorizado. Esta evaluación no crea commits de respaldo porque solo redacta un informe y la base ya es un commit verificable.

Si falla antes de integrar, no publicar/promover: corregir en la rama o volver al baseline en un checkout aislado, conservando el diff para revisión; sin reset/clean sobre el workspace compartido ni force push. Con npm ci y lock originales en ese checkout se puede repetir baseline JS y distinguir fallo de entorno/migración.

Si falla tras integrar, preparar **revert de la migración por PR**: restaurar fuentes JS, import de test, scripts/lock y README correspondientes, sin tocar commits del equipo. Reinstalar dependencias según lock restaurado en entorno de trabajo autorizado; dist no versionado se limpia solo verificando ruta exacta. Ejecutar las cinco pruebas y humo antes de integrar reversión. No cambiar identidad/configuración laboral ni datos Mongo.

Si el fallo es de despliegue, conservar el deployment anterior verificado y aplicar el mecanismo de rollback de plataforma autorizado; sincronizar después el estado Git mediante el PR de reversión. Confirmar qué deployment es válido antes de cambiar tráfico; no se presupone que origin/dev equivalga al deployment actualmente productivo. No se ejecutó rollback aquí.

## 14. Validaciones BE-05.0 realizadas y pendientes

Inspecciones ejecutadas: node/npm, npm ls, lectura de configuración/dependencias instaladas y fuentes; consultas de PR en lectura; Git fetch/creación de rama aislada, sin cambios a otras referencias locales compartidas.

Además se ejecutaron **seis grupos de observaciones HTTP en memoria** sobre el JS existente, sin escribir tests ni agregar rutas: health sin Origin/headers, HEAD automático, ruta desconocida HTML, POST health404, wildcard/Vary/sin credentials y error500 sintético. Todos sus asserts aprobaron. El500 se provocó con un proveedor de allowlist sintético que lanza Error durante el callback existente; console.error mostró ese diagnóstico ficticio y la respuesta pública permaneció genérica. No se envió tráfico a servicios externos ni se alteró configuración persistente.

Resultados de cierre ejecutados:

- **npm test:5 pruebas,5 aprobadas,0 fallos** sobre JavaScript actual: health, CORS permitido, preflight, CORS rechazado y404. Los seis grupos HTTP adicionales descritos arriba no se contabilizan como nuevos tests de la suite ni como tests de una migración.
- **git diff --check: sin errores.** Como el informe es nuevo sin seguimiento, se comprobó adicionalmente su contenido para espacios finales, UTF-8 sin caracteres de reemplazo y bloques Markdown balanceados.
- Enlaces Markdown locales resueltos, referencias a los tres PR comprobadas por conector, tres bloques JSON candidatos sintácticamente válidos. Las configuraciones propuestas no se compilaron ni se ejecutaron.
- Revisión Git: solo `?? INFORME_BE05_PREPARACION_TYPESCRIPT.md`; ningún diff versionado ni staged. Rama feature/be-05-preparacion-typescript; HEAD=origin/dev=main=dev en1bb20f7 y pruebas de ancestro negativas para los commits exclusivos de los tres Draft. Configuración/paquetes/lock/app/tests/Vercel/entorno conservados; documentacion-referencia/ excluida. Revisión acotada del informe sin patrones de secretos.

**No se ejecutaron en BE-05.0:** compilación TS, instalación/ci, scripts futuros, dev/start migrados, validación Vercel build/Preview/deploy, auth, Atlas, frontend/ingesta o normalizadores. No afirmar su aprobación con los resultados del JS actual. No hubo commit, push, PR ni cambios de credenciales/global Git.

## 15. Decisiones del equipo y próximo paso

**Recomendación final: iniciar parcialmente BE-05, sujeto a aceptar A01–A06.** No esperar toda la evidencia agronómica para tipar infraestructura; tampoco considerar superado el mínimo del plan por publicar Drafts.

Próximo paso concreto: revisar este informe y registrar la aprobación del alcance/contrato de regresión, cuatro devDependencies/versiones, scripts en dos terminales y validación Preview. Luego solicitar la implementación limitada en una tarea explícita, respetando el inventario y sin iniciar BE-06. Si el equipo no acepta ese mínimo o quiere cambiar errores/arquitectura simultáneamente, acordar otro alcance antes de programar.

Referencias oficiales consultadas el16/11/2026, únicamente lectura y sin enviar contenido privado del proyecto: documentación TypeScript/Node/Vercel enlazada en §§5/6/10. Algunas páginas dinámicas muestran versiones posteriores al runtime local; sus ejemplos no se copian como selección de versiones instalada. Las páginas de tsx consultadas no estuvieron accesibles y no se usan como evidencia de un ensayo; la alternativa se apoya en la descripción oficial de Node. Configuración de dashboard y artefactos de despliegue no se inspeccionaron.
