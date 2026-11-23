import { z } from 'zod';
import type { Request, Response } from 'express';
import type { createMeasurementHistoryService } from '../services/measurement-history.service.js';
import type { createRequestAuthorization } from '../middlewares/request-authorization.middleware.js';
import { createRequestValidation } from '../middlewares/validate-request.middleware.js';
import { epoch, logicalKey } from '../auth/validation.js';
import { measurementHistoryResponse } from '../dto/measurement.dto.js';
import { ApplicationError } from '../errors/application.error.js';

const params=z.object({id:logicalKey}).strict();
const areaParams=z.object({fieldId:logicalKey,areaId:logicalKey}).strict();
const query=z.object({from:epoch,to:epoch,limit:z.coerce.number().int().min(1).max(200).default(100),after:z.string().max(512).optional()}).strict();
function cursor(value:string|undefined){if(!value)return undefined;try{return JSON.parse(Buffer.from(value,'base64url').toString('utf8')) as unknown;}catch{throw new ApplicationError('VALIDATION_ERROR');}}
export function createMeasurementControllers(service:ReturnType<typeof createMeasurementHistoryService>,auth:ReturnType<typeof createRequestAuthorization>){
  const item=createRequestValidation({params,query}),area=createRequestValidation({params:areaParams,query});
  return Object.freeze({validation:{sensor:item,device:item,field:item,area},handlers:{
    sensor:async(req:Request,res:Response)=>{const data=item.getValidatedData(req);res.json(measurementHistoryResponse(await service.history(auth.getAuthorizationContext(req),{selector:{kind:'sensor',sensorId:data.params.id},...data.query,after:cursor(data.query.after)})));},
    device:async(req:Request,res:Response)=>{const data=item.getValidatedData(req);res.json(measurementHistoryResponse(await service.history(auth.getAuthorizationContext(req),{selector:{kind:'device',physicalDeviceId:data.params.id},...data.query,after:cursor(data.query.after)})));},
    field:async(req:Request,res:Response)=>{const data=item.getValidatedData(req);res.json(measurementHistoryResponse(await service.history(auth.getAuthorizationContext(req),{selector:{kind:'field',fieldId:data.params.id},...data.query,after:cursor(data.query.after)})));},
    area:async(req:Request,res:Response)=>{const data=area.getValidatedData(req);res.json(measurementHistoryResponse(await service.history(auth.getAuthorizationContext(req),{selector:{kind:'area',fieldId:data.params.fieldId,areaId:data.params.areaId},...data.query,after:cursor(data.query.after)})));},
  }});
}
