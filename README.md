# be-agro API

Minimal Express API prepared for Vercel.

Estado auditado al 16/11/2026: JavaScript ESM, Node 24.x, Express, CORS y
`GET /health` (salud del proceso; no verifica MongoDB). Las rutas de negocio
`/api/v1`, autenticación, acceso a Atlas y aislamiento por cliente aún no están
implementados. TypeScript, Zod, Mongoose, Vitest y Supertest están planificados;
las pruebas actuales usan `node:test`.

Consultar [auditoría BE-00/BE-01](INFORME_BE00_BE01.md),
[especificación](ESPECIFICACION.md), [plan](IMPLEMENTATION_PLAN.md) y
[modelo propuesto](SCHEMA_PROPUESTA.md). Rigen colecciones convencionales (no
Time Series) y Cliente → Campo → Área → Dispositivo → Mediciones.
La entrega BE-00/BE-01 cambia documentación, sin migrar ni instalar paquetes.

`documentacion-referencia/` permanece local, excluida mediante
`.git/info/exclude`; no debe agregarse al repositorio. Solo se comprobó la rama
`main`: acordar la rama de integración antes de iniciar nuevas funcionalidades.

## Local development

```bash
npm install
npm run dev
```

The API runs at `http://localhost:3000`. Check it with:

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
npm test
```

## Deploy to Vercel

Vercel detects `src/app.js` as an Express entry point and deploys the app as a
single Vercel Function. No build command or output directory is required.

With the Vercel CLI:

```bash
npx vercel
```

After checking the preview deployment, deploy to production:

```bash
npx vercel --prod
```

Alternatively, import this Git repository in the Vercel dashboard. Keep the
repository root as the project root; the included `vercel.json` selects the
Express framework and enables Fluid compute.
