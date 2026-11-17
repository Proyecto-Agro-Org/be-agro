# be-agro API

Minimal Express API prepared for Vercel.

## BE-09 recuperada sobre dev consolidada — 17/11/2026

La base de esta entrega es `origin/dev` en
`636c71731ee100f78c76c78b46753ccf1223ac39`, que incorpora BE-02 a BE-08 mediante
[PR #10](https://github.com/Proyecto-Agro-Org/be-agro/pull/10). Los apartados de
consolidación local siguientes registran su preparación histórica; ese merge ya
se completó. BE-02/03/04 siguen como propuestas documentales, sin aprobación física,
científica o de contratos por su incorporación.

Se recuperaron selectivamente diez entregables BE-09.0/09.1 en
`feature/be-09-infraestructura-sobre-dev`. Los originales y el informe privado BE-05
permanecen intactos en su working tree previo. No se trasladó ese informe, ni
referencias locales, dependencias instaladas o compilados.

BE-09.1 es **infraestructura interna, no autenticación productiva completa**:
puertos de credenciales/identidad/pertenencia/sesión, capacidades con procedencia
privada, contexto por request y lectura de referencias acotada al cliente.
Los fakes solo viven en tests; la app default no monta esta infraestructura,
no incorpora login/Google simulado ni endpoints nuevos. Health continúa público.
No existen modelos definitivos ni consultas Atlas. La integración real requiere
proveedor aprobado, catálogo confiable y decisiones de sesión/BE-02/03/FE.

Evidencia y alcance de la recuperación:
[informe BE-09 sobre dev](INFORME_RECUPERACION_BE09_SOBRE_DEV.md),
[implementación](INFORME_BE09_1_INFRAESTRUCTURA_AUTORIZACION.md) y
[auditoría](INFORME_BE09_1_AUDITORIA_SEGURIDAD.md). Los cuatro informes/matriz
recuperados conservan la evidencia original de su fase local; el informe de
recuperación distingue esa base histórica de la base consolidada vigente.
No se declara BE-09 Done ni se inicia BE-09.2.

## Consolidación local BE-02 a BE-08 — 17/11/2026

La rama `integration/be-02-a-be-08` reúne localmente los commits originales BE-05,
BE-06, BE-07.1, BE-07.2 y BE-08 mediante merges, desde `origin/dev` en
`1bb20f76b7a739f42c75b37b9a64315276560ec1`. Incorpora BE-02/03/04 exclusivamente
como **documentación provisional**, sin aprobar modelos físicos, contratos ni
conversiones. No incorpora los entregables locales BE-09 ni el informe local BE-05.

Validación de esta consolidación: npm ci, typecheck, build y **120/120 pruebas**
aprobados. Diferencial contra BE-07.2: 13 escenarios, **11 compatibles y dos cambios
intencionales de seguridad del 404**, sin regresiones detectadas. Código, tests,
package/lock, tsconfig y configuración Vercel son idénticos al commit BE-08.

**Sin publicación ni merge remoto:** no pudo comprobarse en Vercel qué rama produce
Production ni si un push/integración puede afectarla. GitHub no muestra protección
para `dev`, pero eso no resuelve el control externo. No se marca ninguna etapa Done.
Vercel Preview funcional, revisión del equipo e integración permanecen pendientes.
Detalle, respaldos, discrepancias documentales y procedimiento de continuación:
[informe de consolidación](INFORME_CONSOLIDACION_DEV_BE02_BE08.md).

Precedencia al consumir los documentos incorporados: acuerdos confirmados y código
implementado → propuestas pendientes BE-02/03/04. `docs/openapi.json` **no es un
inventario de rutas desplegadas**. Solo health existe; el envelope anidado propuesto,
las reglas de unidades y el diagrama Mongo no se activan por estar en esta rama.
Se conserva error string transitorio, UUID/logging seguro y 404 no reflectante de
BE-08; el perfil HTTP completo sigue optativo.

## Antecedentes de las entregas

Los resultados siguientes describen sus etapas originales; para el estado conjunto
vigente consultar el apartado anterior y el informe de consolidación.

Estado local BE-08.5 al 17/11/2026: TypeScript ESM compilado, Node 24.x, Express 5, CORS y
`GET /health` (salud del proceso; no verifica MongoDB). Las rutas de negocio
`/api/v1`, autenticación, acceso a Atlas y aislamiento por cliente aún no están
implementados. Mongoose y Zod están incorporados para infraestructura MongoDB
explícita y validación de su configuración; no hay modelos ni conexión automática.
Vitest y Supertest siguen planificados;
las pruebas actuales conservan `node:test` y ejecutan el JavaScript compilado.
La migración local no está Done: la validación Vercel Preview sigue pendiente.

Consultar [auditoría BE-00/BE-01](INFORME_BE00_BE01.md),
[especificación](ESPECIFICACION.md), [plan](IMPLEMENTATION_PLAN.md) y
[modelo propuesto](SCHEMA_PROPUESTA.md). Rigen colecciones convencionales (no
Time Series) y Cliente → Campo → Área → Dispositivo → Mediciones.
La evaluación y el alcance de BE-05 están en
[preparación TypeScript](INFORME_BE05_PREPARACION_TYPESCRIPT.md) y
[contrato técnico](APROBACION_TECNICA_BE05.md). No se incorporaron los commits
exclusivos de los PR Draft BE-02/03/04 en aquella entrega; ahora se reúnen como
propuestas documentales en la consolidación local descrita arriba.
Los resultados actuales están en [implementación](INFORME_BE05_IMPLEMENTACION_TYPESCRIPT.md)
y [auditoría BE-05.2](INFORME_BE05_AUDITORIA_TYPESCRIPT.md):18/18 pruebas y13/13
escenarios HTTP locales equivalentes para BE-05; Preview y revisión/integración pendientes.

La implementación incremental BE-06 separa health, configuración CORS y errores
legacy, sin cambiar sus contratos. Validación local: **21/21 pruebas** (18
conservadas y tres nuevas) y **13/13 escenarios HTTP equivalentes** frente al
commit BE-05 `e2c19c38cf2ad8f40c98aaff5d8248a561ccb474`.
Ver [informe BE-06](INFORME_BE06_ARQUITECTURA_CAPAS.md). BE-06 no está Done:
revisión/integración pendientes; no se realizaron despliegues.
La [auditoría BE-06.1](INFORME_BE06_AUDITORIA.md) repitió estas validaciones
sin encontrar defectos que requieran cambios de código. Propone un futuro PR
Draft hacia `feature/be-05-preparacion-typescript`, después de revisar y guardar
el delta BE-06. Antes de publicar debe verificarse el control del autodeploy;
el Preview de BE-05 continúa pendiente.

BE-07.1 agrega infraestructura local sin Atlas: **46/46 pruebas** (21 HTTP/capas
y 25 de infraestructura Mongo), typecheck y build aprobados. Ver el
[informe BE-07.1](INFORME_BE07_INFRAESTRUCTURA_MONGOOSE_ZOD.md).
La [auditoría BE-07.1A](INFORME_BE07_AUDITORIA.md) corrigió la validación de
nombres de base decodificados y el bloqueo de cierre tras un fallo de Mongoose.
La etapa completa BE-07 sigue pendiente de revisión e integración. BE-07.2 agrega
infraestructura de validación de requests sin contratos de negocio definitivos:
**73/73 pruebas** (46 anteriores y 27 de requests), typecheck y build aprobados.
Ver [informe BE-07.2](INFORME_BE07_2_VALIDACION_REQUESTS.md).
La [auditoría BE-07.2A](INFORME_BE07_2_AUDITORIA.md) corrigió resultados async
obsoletos sobre un mismo Request y la copia de metadata extra en errores.

`documentacion-referencia/` permanece local, excluida mediante
`.git/info/exclude`; no debe agregarse al repositorio. La rama de integración
acordada es `dev`; la consolidación sigue local en `integration/be-02-a-be-08`,
sin modificar `dev` ni `main`.

## Arquitectura local BE-06

```text
src/
  app.ts                              # Composición; factory y export default sin listen
  config/cors.ts                      # Lectura de CORS_ORIGINS al crear cada app
  routes/health.routes.ts             # Router GET /health
  controllers/health.controller.ts     # HTTP 200 y mapeo explícito a DTO
  services/health.service.ts           # Salud del proceso, sin Express ni persistencia
  dto/health.dto.ts                    # GetHealthResponse; DTORequest no aplica
  middlewares/cors.middleware.ts       # Política CORS existente por instancia
  middlewares/legacy-error.middleware.ts # Errores legacy centralizados
scripts/start.ts                       # Listener local sin cambios
```

Flujo de health: router → controller → service; la respuesta se mapea al DTO
en el controller. No hay repository/model para health. Persistencia, adapters
y mappers de dominio se añadirán al existir una responsabilidad aprobada;
no se crean carpetas vacías ni consultas ficticias. El service no conoce HTTP.
Los DTOs son tipos estáticos; no validan entradas HTTP en runtime. Health no
consume params, query ni body y continúa público, sin comprobar Atlas.

El perfil default actual usa contexto UUID → CORS → rutas → 404 → handler legacy
→ frontera terminal, con callback final de dispatch protegido. Se conserva el
404 HTML genérico sin pathname; el perfil optativo BE-08 se describe más abajo. Autenticación
y contrato uniforme definitivo siguen pendientes. Comandos y entrada prevista
de Vercel no cambian. BE-06 se publicó originalmente encadenada a BE-05; esta
consolidación conserva esa ascendencia y permite revisar el conjunto hacia `dev`.
Una futura publicación exige primero verificar el riesgo del autodeploy.

## Infraestructura MongoDB — BE-07.1

Dependencias runtime exactas: `mongoose@9.12.2` y `zod@4.6.7`.

- `src/config/mongodb.ts`: `loadMongoConfig(environment)` valida con Zod y el
  parser local del driver. `MONGODB_URI` requiere esquema mongodb/mongodb+srv,
  host y base explícita. La base decodificada debe ocupar menos de 64 bytes UTF-8
  y no contener caracteres prohibidos. No se resuelve DNS ni se verifica acceso
  al parsear; las credenciales codificadas válidas se conservan sin transformarlas.
- `MONGODB_SERVER_SELECTION_TIMEOUT_MS`: string entero de 100 a 30000 ms,
  default 5000. URI ausente o inválida falla al solicitar configuración/conexión,
  no al arrancar health. `.env.example` contiene un dominio reservado sin secretos.
- `src/infrastructure/mongodb.ts`: `mongoConnection` ofrece `connect(environment)`,
  `disconnect()` y `getState()`. Solo un consumidor autorizado debe llamar a connect;
  app, listener, controllers y health no lo llaman. No copiar conexiones reales
  a pruebas: estas inyectan una factory simulada y usan entornos explícitos.
- La apertura concurrente comparte un intento y el pool se reutiliza por proceso.
  No desconectar por request en serverless; el cierre explícito corresponde a
  finalización controlada o pruebas. No se registran handlers de señales globales.
- Si falla un cierre o la limpieza de una apertura fallida, ese manager queda en
  error permanente: connect/disconnect posteriores rechazan sin volver al driver.
  Mongoose puede quedar en disconnecting y esperar un evento close inexistente.
  Se necesita descarte/reinicio controlado del worker; no crear otro pool en el
  mismo proceso para eludir el bloqueo. Un fallo de apertura cuya limpieza sí
  termina correctamente permite un reintento explícito.
  La misma cuarentena aplica si falla el cierre previo a una reapertura;
  no se reintenta ese cierre ni se permite abrir otro pool.
- Se deshabilitan autoCreate, autoIndex y buffering; no hay modelos ni queries.
  Fallos de configuración, apertura y cierre tienen códigos distintos y mensajes
  seguros, sin causa original. No registrar objetos de configuración o conexiones:
  contienen datos sensibles. Esto no cambia el formato HTTP legacy.

La reutilización solo alcanza una instancia caliente del proceso, no todos los
workers de Vercel. Atlas, credenciales, permisos, conectividad y presupuesto de
conexiones requieren validación futura autorizada. No hay readiness de DB;
`/health` sigue midiendo únicamente salud del proceso.

## Validación de requests — BE-07.2

`createRequestValidation` en `src/middlewares/validate-request.middleware.ts`
recibe esquemas Zod independientes para body, params y query. Usa safeParseAsync
y solo lee las partes configuradas. No reemplaza req.body, req.params ni req.query.

Ejemplo didáctico de consumo; no registra una ruta ni aprueba un contrato:

```ts
import type { Request, Response } from 'express';
import { z } from 'zod';
import { createRequestValidation } from './middlewares/validate-request.middleware.js';

const input = createRequestValidation(
  { body: z.object({ label: z.string().trim() }) },
  { publicFields: { body: ['label'] } },
);
// En una operación futura: parser aprobado → input.middleware → controller.
function controller(request: Request, response: Response) {
  const { body } = input.getValidatedData(request);
  response.json({ label: body.label });
}
```

Middleware y accessor deben pertenecer a la misma instancia creada para la
operación. Los datos viven en un WeakMap privado por request; el accessor falla
antes de una validación satisfactoria y no devuelve éxitos parciales. Los tipos
se infieren de z.output, incluyendo transformaciones. No leer el input crudo
como sustituto de los datos validados. El contenedor es readonly/congelado, no
una garantía de inmutabilidad profunda de cualquier salida personalizada Zod.
Cada ejecución tiene una generación privada: una ejecución antigua que termina
después de otra sobre el mismo Request no puede sobreescribir sus resultados.
Se rechaza con un error interno de ejecución. Esto no cancela refinamientos;
la integración normal debe invocar el middleware una vez por operación.
Los campos opcionales ausentes y los explícitamente undefined se conservan como
los distingue el esquema. Una parte configurada aparece aunque su salida sea
undefined; una parte no configurada no aparece. JSON no representa undefined.

Los errores internos distinguen invalidación esperada y fallo de ejecución de
un refinamiento. Las issues incluyen part, path, code y un mensaje fijo seguro;
no contienen input ni mensajes originales de Zod. publicFields debe ser una
lista estática de nombres autorizados: los demás segmentos se redactan como
[field] y los índices como [index], porque un path personalizado puede contener
datos sensibles. El array path vacío identifica el error de la parte completa.

El middleware solo llama a next; no elige status, serializa errores ni modifica
el handler legacy. BE-08 integra estos errores en un perfil HTTP optativo antes
de conectar esta infraestructura a rutas reales. El parser JSON y los límites de entrada
deben acordarse por operación. Health no recibe validación Zod. No se agregan
esquemas ni endpoints de negocio ni dependencia MongoDB.

## Errores, logging y seguridad — BE-08 local

La evaluación [BE-08.3/08.4/08.5](INFORME_BE08_3_HARDENING_SEGURIDAD.md)
cerró los hallazgos de logging raw y 404 reflectante. **Apta técnicamente para
PR Draft**, sin publicar y sin marcar BE-08 Done. Ver la
[matriz de seguridad y regresión](MATRIZ_BE08_SEGURIDAD_Y_REGRESION.md).

Validación local: **120/120 pruebas**, 18 nuevas sobre BE-08.2; npm ci,
typecheck, build y diff check aprobados. Diferencial contra BE-07.2: **11 escenarios
compatibles y 2 cambios intencionales de seguridad**, no 13 respuestas idénticas.
Sin dependencias nuevas ni acceso a Atlas.

El default incorpora UUID servidor y logs de error mediante DTO nuevo, congelado
y de campos primitivos permitidos. No llegan Error/Request/Response, stack, cause,
headers, body, query, pathname ni metadata extra a sus sinks. La consola recibe
su JSON. No se adoptan IDs externos ni cambia trust proxy. Un logger lento/fallido
no bloquea HTTP; es best effort, sin garantía de persistencia o flush serverless.
El default no agrega logs globales de inicio/final.

Su 404 conserva HTML y status 404 con body genérico constante. Los antiguos textos
Cannot GET/POST con la ruta fueron eliminados. GET/HEAD health, CORS y errores
HTTP 403/500 mantienen status y body. X-Request-ID es una adición intencional;
no se agregó Expose-Headers para leerlo desde JavaScript cross-origin.

El perfil completo continúa optativo para no imponer parser ni contratos pendientes:

```ts
import { createApp } from './app.js';
import { createHttpInfrastructure } from './http/infrastructure.js';

const app = createApp({ httpInfrastructure: createHttpInfrastructure() });
// No inicia listener ni conecta MongoDB. No reemplaza la exportación default.
```

Ese perfil ofrece logs start/finish/error, 400 Zod, 404 JSON, nosniff, no-referrer,
no-store y CSP; parser JSON estricto, 16 KiB propuestos configurables mediante
bodyLimitBytes de 1 byte a 1 MiB, y 400/413/415 controlados. CORS se conserva
sin credentials globales. El default mantiene x-powered-by deshabilitado y refuerza
headers del 404, sin activar globalmente ese parser.

Ambos modos tienen frontera terminal y callback final de dispatch propios:
un stream parcial se cierra sin error original y múltiples next(error) tardíos
no llegan al logger raw de Express. Se valida handle en runtime; la dependencia
de Express instalado debe revalidarse al actualizarlo y en Preview.
Apps aisladas que monten los módulos deben usar http.protectApplication(app)
y http.terminalErrorHandler, como los fixtures.

El adaptador usa provisionalmente error:string, sin aprobar el DTO uniforme final
BE-03. Faltan revisión FE/BE, límites/media types por operación, activación acordada
del perfil completo, Preview Vercel autorizado e integración. Un rollback debe
conservar logging sanitizado y 404 no reflectante. Publicar puede generar Preview;
esta tarea no hizo commit, push ni deploy.

## Local development

```bash
npm ci
npm run dev
```

`npm run dev` builds the application and watches the generated JavaScript.
In a second terminal, run the TypeScript compiler in watch mode:

```bash
npm run dev:build
```

Both terminals are needed to rebuild and restart after editing TypeScript.
A compiler error can leave the last successful build running: a health response
does not prove the current source compiled. Restart explicitly after changing
`.env`. The API runs at `http://localhost:3000` by default. Check it with:

```bash
curl http://localhost:3000/health
```

Expected response:

```json
{"status":"ok"}
```

## CORS

Copy `.env.example` to `.env` and set the frontend origins that may call the
API from a browser:

```env
CORS_ORIGINS=http://localhost:5173,https://app.example.com
```

Origin matching is exact. Requests without an `Origin` header, such as curl or
server-to-server requests, remain allowed. You can use `CORS_ORIGINS=*` for a
fully public API, although explicit origins are safer for production.

CORS no autentica usuarios ni limita datos por cliente. El servidor actual no
configura `credentials`; su rechazo usa HTTP 403 con `{ "error": "Origin not
allowed by CORS" }`. El formato objetivo de errores y la sesión real requieren
el cambio coordinado previsto en la especificación.

On Vercel, add `CORS_ORIGINS` under **Project Settings → Environment
Variables** for Production, Preview, and Development as needed, then redeploy.

## Tests

```bash
npm run typecheck
npm test
```

`npm test` builds first and runs the existing five regression tests plus
HTTP/startup/environment cases against `dist/src/app.js`, using synthetic inputs
and ephemeral ports. Node discovers all test files automatically, including the
independent app/CORS configuration regression in `test/app-isolation.test.js`.
No Atlas or production credentials are required. Temporary
`.env` fixtures are created outside the project; the project's environment is
not edited by tests.

## Build and local production startup

```bash
npm run build
npm start
```

`tsc` emits `dist/src/app.js` and `dist/scripts/start.js`. `npm start` runs only
JavaScript and expects a successful build; TypeScript and its declarations are
development dependencies. `dist/` stays untracked. A clean acceptance build must
not rely on output left by an earlier build, because `noEmitOnError` does not
remove stale files.

`src/app.ts` exports the factory and default Express app without listening.
`scripts/start.ts` is the local listener, preserving PORT parsing and the optional
Node `.env` loader. Imports keep `.js` extensions for the compiled ESM layout.

## Vercel compatibility — Preview pending

The planned Express entry is now `src/app.ts`, with its default export and direct
Express import. The existing `vercel.json` remains unchanged (`framework: express`,
`fluid: true`). Keep the repository root and do not configure `dist/` as a static
output directory or assume Vercel starts the local listener via `npm start`.

Local compilation and tests do not validate the deployed platform. A separately
authorized Preview must confirm effective Node/build/install settings, source
entry detection and HTTP/CORS behavior before integration. No deploy or platform
configuration change was performed as part of the local migration. Publishing
a branch can trigger automatic Vercel deployments; review and authorize that
effect before a future push. Production promotion is outside this task.
