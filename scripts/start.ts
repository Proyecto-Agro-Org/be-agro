import app from '../src/app.js';

const port = Number.parseInt(process.env.PORT ?? '3000', 10);

app.listen(port, () => {
  console.log(`API listening on http://localhost:${port}`);
});
