# be-agro API

Minimal Express API prepared for Vercel.

Estado local BE-06 al 16/11/2026: TypeScript ESM compilado, Node 24.x, Express 5, CORS y
`GET /health` (salud del proceso; no verifica MongoDB). Las rutas de negocio
`/api/v1`, autenticación, acceso a Atlas y aislamiento por cliente aún no están
implementados. Zod, Mongoose, Vitest y Supertest siguen planificados;
las pruebas actuales conservan `node:test` y ejecutan el JavaScript compilado.
La migración local no está Done: la validación Vercel Preview sigue pendiente.

Consultar [auditoría BE-00/BE-01](INFORME_BE00_BE01.md),
[especificación](ESPECIFICACION.md), [plan](IMPLEMENTATION_PLAN.md) y
[modelo propuesto](SCHEMA_PROPUESTA.md). Rigen colecciones convencionales (no
Time Series) y Cliente → Campo → Área → Dispositivo → Mediciones.
La evaluación y el alcance de BE-05 están en
[preparación TypeScript](INFORME_BE05_PREPARACION_TYPESCRIPT.md) y
[contrato técnico](APROBACION_TECNICA_BE05.md). No se incorporaron los commits
exclusivos de los PR Draft BE-02/03/04.
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

`documentacion-referencia/` permanece local, excluida mediante
`.git/info/exclude`; no debe agregarse al repositorio. La rama de integración
acordada es `dev`; esta implementación sigue local en su rama de trabajo.

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

El orden global sigue siendo CORS → rutas → handler legacy. Se conserva el
404 HTML de Express; errores uniformes, autenticación, logging nuevo y
validación de entorno quedan para sus etapas. Comandos y entrada prevista
de Vercel no cambian. BE-06 parte de la rama BE-05 aún no integrada, por lo
que una futura publicación deberá revisar esa dependencia y el autodeploy.

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
