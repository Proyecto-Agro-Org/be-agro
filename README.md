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
