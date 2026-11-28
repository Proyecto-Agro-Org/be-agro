import { Router, type RequestHandler } from 'express';
import { getHealth } from '../controllers/health.controller.js';

export function createHealthRouter(...middlewares: RequestHandler[]) {
  const router = Router();
  router.get('/health', ...middlewares, getHealth);
  return router;
}
