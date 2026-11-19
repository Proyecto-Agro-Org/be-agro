import { Router } from 'express';
import type { BusinessService } from '../services/business.service.js';
import type { HttpInfrastructure } from '../http/infrastructure.js';
import { createRequestAuthorization } from '../middlewares/request-authorization.middleware.js';
import { createBusinessControllers } from '../controllers/business.controller.js';
import { ApplicationError } from '../errors/application.error.js';

// Explicit isolated composition ONLY. Not imported by app/server/start; no environment switch.
// A production mount requires session integration, dependencies and physical mapping approval.
export function createBusinessRouter(service: BusinessService, http: HttpInfrastructure) {
  const router = Router(), auth = createRequestAuthorization(service.authorization);
  const { validation: v, handlers: h } = createBusinessControllers(service, auth);
  router.use(auth.authenticate, auth.requireClient, http.jsonBody);
  router.use((request, _response, next) => {
    if (['GET', 'DELETE'].includes(request.method) && request.body !== undefined) { next(new ApplicationError('VALIDATION_ERROR')); return; }
    next();
  });
  router.get('/clientes/actual', http.routeLabel('business.client'), v.current.middleware, h.current);
  router.get('/campos', http.routeLabel('business.fields.list'), v.listFields.middleware, h.listFields);
  router.post('/campos', http.routeLabel('business.fields.create'), v.createField.middleware, h.createField);
  router.get('/campos/:campoId', http.routeLabel('business.fields.get'), v.getField.middleware, h.getField);
  router.patch('/campos/:campoId', http.routeLabel('business.fields.patch'), v.patchField.middleware, h.patchField);
  router.delete('/campos/:campoId', http.routeLabel('business.fields.deactivate'), v.deleteField.middleware, h.deleteField);
  router.get('/areas', http.routeLabel('business.areas.list'), v.listAreas.middleware, h.listAreas);
  router.post('/campos/:campoId/areas', http.routeLabel('business.areas.create'), v.createArea.middleware, h.createArea);
  router.get('/areas/:areaId', http.routeLabel('business.areas.get'), v.getArea.middleware, h.getArea);
  router.patch('/areas/:areaId', http.routeLabel('business.areas.patch'), v.patchArea.middleware, h.patchArea);
  router.delete('/areas/:areaId', http.routeLabel('business.areas.deactivate'), v.deleteArea.middleware, h.deleteArea);
  return router;
}
