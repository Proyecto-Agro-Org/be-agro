import type { AuthorizationContext } from '../auth/contracts.js';
import { ApplicationError } from '../errors/application.error.js';
import type { MeasurementHistoryPort, MeasurementPageRequest } from '../measurements/contracts.js';
import { measurementPageRequestSchema, measurementPageSchema } from '../measurements/schemas.js';
import type { SessionService } from './session.service.js';
import { callPort, checkedOutput } from '../auth/validation.js';
import { catalogueRealmSchema } from '../auth/identity-catalogue.schemas.js';

export function createMeasurementHistoryService(sessions:SessionService,repository:MeasurementHistoryPort,options:{realm:string}){
  if(typeof repository?.findPage!=='function')throw new TypeError('Measurement history port is incomplete');
  const realmResult=catalogueRealmSchema.safeParse(options?.realm);if(!realmResult.success)throw new TypeError('Invalid measurement realm');const realm=realmResult.data;
  const authorization=sessions.authorization;
  async function refresh(context:AuthorizationContext,clientId:string){
    authorization.assertContext(context);const view=await sessions.current(context);
    if(view.user.client?.id!==clientId)throw new ApplicationError('FORBIDDEN');
    authorization.assertContext(context);
  }
  async function history(context:AuthorizationContext,input:unknown){
    let request:MeasurementPageRequest;
    try{const parsed=measurementPageRequestSchema.safeParse(input);if(!parsed.success)throw new Error();request=parsed.data;}catch{throw new ApplicationError('VALIDATION_ERROR');}
    authorization.assertContext(context);const clientId=context.clientId;await refresh(context,clientId);
    const page=checkedOutput(measurementPageSchema,await callPort(()=>repository.findPage({...request,realm,clientId})));
    let previous:{attributedAt:number;id:string}|undefined;
    const ids=new Set<string>();
    for(const row of page.items){
      if(row.realm!==realm||row.clientId!==clientId)throw new ApplicationError('RESOURCE_NOT_FOUND');
      const selector=request.selector;
      const matches=selector.kind==='sensor'?row.sensorId===selector.sensorId:selector.kind==='device'?row.physicalDeviceId===selector.physicalDeviceId:
        selector.kind==='area'?row.fieldId===selector.fieldId&&row.areaId===selector.areaId:row.fieldId===selector.fieldId;
      if(!matches)throw new ApplicationError('RESOURCE_NOT_FOUND');
      if(row.attributedAt<request.from||row.attributedAt>=request.to||ids.has(row.id))throw new ApplicationError('INTERNAL_ERROR');
      if(previous&&(row.attributedAt>previous.attributedAt||(row.attributedAt===previous.attributedAt&&row.id>=previous.id)))throw new ApplicationError('INTERNAL_ERROR');
      ids.add(row.id);previous={attributedAt:row.attributedAt,id:row.id};
    }
    if(page.items.length>request.limit)throw new ApplicationError('INTERNAL_ERROR');
    const last=page.items.at(-1);if(page.next&&(!last||page.next.attributedAt!==last.attributedAt||page.next.id!==last.id))throw new ApplicationError('INTERNAL_ERROR');
    await refresh(context,clientId);return Object.freeze({items:Object.freeze(page.items.map(row=>Object.freeze({...row}))),next:page.next?Object.freeze({...page.next}):null});
  }
  async function latest(context:AuthorizationContext,input:{selector:unknown;at:number}){
    return history(context,{selector:input?.selector,from:0,to:input?.at,limit:1});
  }
  return Object.freeze({history,latest});
}
