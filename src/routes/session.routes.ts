import { Router } from 'express';
import { z } from 'zod';
import { callPort, checkedOutput } from '../auth/validation.js';
import { createSessionControllers } from '../controllers/session.controller.js';
import { ApplicationError } from '../errors/application.error.js';
import type { HttpInfrastructure } from '../http/infrastructure.js';
import { createCorsMiddleware } from '../middlewares/cors.middleware.js';
import { createRequestAuthorization } from '../middlewares/request-authorization.middleware.js';
import type { SessionService } from '../services/session.service.js';

export type AuthenticationOperation = 'challenge' | 'login' | 'session' | 'logout';
// Must implement a shared/deployment-appropriate budget; no process-local default.
export interface AuthenticationAdmission { admit(operation: AuthenticationOperation): Promise<boolean> }

// Composition only: NOT imported or mounted by app.ts. Caller supplies one BE08
// infrastructure/context and an explicit shared admission mechanism.
export function createSessionRouter(service: SessionService, http: HttpInfrastructure, admission: AuthenticationAdmission) {
  if (typeof admission?.admit !== 'function') throw new TypeError('Authentication admission port required.');
  const admit = admission.admit.bind(admission);
  const origins = new Set(service.allowedOrigins);
  const auth = createRequestAuthorization(service.authorization);
  const controller = createSessionControllers(service, auth), router = Router();
  router.use((_request, response, next) => { response.setHeader('Cache-Control', 'no-store'); next(); });
  router.use(createCorsMiddleware(origins));
  router.use((request, _response, next) => {
    if (request.method === 'POST' && (typeof request.headers.origin !== 'string' || !origins.has(request.headers.origin))) {
      next(new ApplicationError('FORBIDDEN')); return;
    }
    next();
  });
  router.use(http.jsonBody);
  function budget(operation: AuthenticationOperation): import('express').RequestHandler {
    return async (_request, _response, next) => {
      try {
        if (!checkedOutput(z.boolean(), await callPort(() => admit(operation)))) throw new ApplicationError('RATE_LIMITED');
      } catch (error: unknown) { next(error); return; }
      next();
    };
  }
  router.post('/google/challenge', http.routeLabel('authChallenge'), budget('challenge'), controller.challengeInput.middleware, controller.challenge);
  router.post('/login', http.routeLabel('authLogin'), budget('login'), controller.loginInput.middleware, controller.login);
  router.get('/session', http.routeLabel('authSession'), budget('session'), controller.noInput.middleware, auth.authenticate, auth.requireClient, controller.current);
  router.post('/logout', http.routeLabel('authLogout'), budget('logout'), controller.noInput.middleware, controller.logout);
  return router;
}
