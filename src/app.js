import express from 'express';

const app = express();

app.disable('x-powered-by');

app.get('/health', (_request, response) => {
  response.status(200).json({ status: 'ok' });
});

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(500).json({ error: 'Internal server error' });
});

export default app;
