# be-agro API

Minimal Express API prepared for Vercel.

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
