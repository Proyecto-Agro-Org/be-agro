import type { RequestHandler } from 'express';
import type { BusinessService } from '../services/business.service.js';
import type { createRequestAuthorization } from '../middlewares/request-authorization.middleware.js';
import { createRequestValidation } from '../middlewares/validate-request.middleware.js';
import { createBusinessSchema, patchBusinessSchema, pageSchema, deleteSchema, fieldParams, areaParams,
  areaQuery, areaItemQuery, areaDeleteQuery, emptySchema } from '../business/schemas.js';
import { campoResponse, areaResponse, camposResponse, areasResponse } from '../dto/business.dto.js';

export function createBusinessControllers(service: BusinessService, auth: ReturnType<typeof createRequestAuthorization>) {
  const current = createRequestValidation({ params: emptySchema, query: emptySchema });
  const listFields = createRequestValidation({ params: emptySchema, query: pageSchema });
  const getField = createRequestValidation({ params: fieldParams, query: emptySchema });
  const createField = createRequestValidation({ params: emptySchema, query: emptySchema, body: createBusinessSchema });
  const patchField = createRequestValidation({ params: fieldParams, query: emptySchema, body: patchBusinessSchema });
  const deleteField = createRequestValidation({ params: fieldParams, query: deleteSchema });
  const listAreas = createRequestValidation({ params: emptySchema, query: areaQuery });
  const getArea = createRequestValidation({ params: areaParams, query: areaItemQuery });
  const createArea = createRequestValidation({ params: fieldParams, query: emptySchema, body: createBusinessSchema });
  const patchArea = createRequestValidation({ params: areaParams, query: areaItemQuery, body: patchBusinessSchema });
  const deleteArea = createRequestValidation({ params: areaParams, query: areaDeleteQuery });
  const context = auth.getAuthorizationContext;
  const handlers: Record<string, RequestHandler> = {
    current: async (req, res) => { current.getValidatedData(req); res.json(await service.current(context(req))); },
    listFields: async (req, res) => { const { query } = listFields.getValidatedData(req); res.json(camposResponse(await service.listFields(context(req), query))); },
    getField: async (req, res) => { const { params } = getField.getValidatedData(req); res.json(campoResponse(await service.getField(context(req), params.campoId))); },
    createField: async (req, res) => { const { body } = createField.getValidatedData(req); const row = await service.createField(context(req), { name: body.nombre, description: body.descripcion ?? null }); res.status(201).json(campoResponse(row)); },
    patchField: async (req, res) => { const { params, body } = patchField.getValidatedData(req); res.json(campoResponse(await service.patchField(context(req), params.campoId, { name: body.nombre, description: body.descripcion, version: body.version }))); },
    deleteField: async (req, res) => { const { params, query } = deleteField.getValidatedData(req); await service.deactivateField(context(req), params.campoId, query.version); res.status(204).end(); },
    listAreas: async (req, res) => { const { query } = listAreas.getValidatedData(req); res.json(areasResponse(await service.listAreas(context(req), query.campo_id, { after: query.after, limit: query.limit }))); },
    getArea: async (req, res) => { const { params, query } = getArea.getValidatedData(req); res.json(areaResponse(await service.getArea(context(req), query.campo_id, params.areaId))); },
    createArea: async (req, res) => { const { params, body } = createArea.getValidatedData(req); const row = await service.createArea(context(req), params.campoId, { name: body.nombre, description: body.descripcion ?? null }); res.status(201).json(areaResponse(row)); },
    patchArea: async (req, res) => { const { params, query, body } = patchArea.getValidatedData(req); res.json(areaResponse(await service.patchArea(context(req), query.campo_id, params.areaId, { name: body.nombre, description: body.descripcion, version: body.version }))); },
    deleteArea: async (req, res) => { const { params, query } = deleteArea.getValidatedData(req); await service.deactivateArea(context(req), query.campo_id, params.areaId, query.version); res.status(204).end(); },
  };
  return { validation: { current, listFields, getField, createField, patchField, deleteField, listAreas, getArea, createArea, patchArea, deleteArea }, handlers };
}
