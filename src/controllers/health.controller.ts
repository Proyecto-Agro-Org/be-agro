import type { RequestHandler } from 'express';
import type { GetHealthResponse } from '../dto/health.dto.js';
import { getHealthStatus } from '../services/health.service.js';

export const getHealth: RequestHandler<
  Record<string, never>, GetHealthResponse, unknown, Record<string, never>
> = (_request, response) => {
  const health = getHealthStatus();
  const body: GetHealthResponse = { status: health.status };
  response.status(200).json(body);
};
