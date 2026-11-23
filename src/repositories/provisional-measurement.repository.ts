import { ApplicationError } from '../errors/application.error.js';
import type { AttributedMeasurement, MeasurementHistoryPort, MeasurementPageRequest, MeasurementSelector } from '../measurements/contracts.js';
import { attributedMeasurementSchema, measurementPageRequestSchema } from '../measurements/schemas.js';
import { checkedOutput } from '../auth/validation.js';
import { catalogueRealmSchema } from '../auth/identity-catalogue.schemas.js';

function selected(row:AttributedMeasurement,selector:MeasurementSelector){
  if(selector.kind==='sensor')return row.sensorId===selector.sensorId;
  if(selector.kind==='device')return row.physicalDeviceId===selector.physicalDeviceId;
  if(selector.kind==='area')return row.fieldId===selector.fieldId&&row.areaId===selector.areaId;
  return row.fieldId===selector.fieldId;
}

// Isolated adapter for synthetic/local validation only. It is never selected by
// environment configuration or imported by app.ts, and declares no Atlas BSON mapping.
export function createProvisionalMeasurementRepository(input:readonly unknown[]):MeasurementHistoryPort{
  const rows=input.map(row=>Object.freeze(checkedOutput(attributedMeasurementSchema,row)));
  if(new Set(rows.map(row=>row.id)).size!==rows.length||new Set(rows.map(row=>row.eventId)).size!==rows.length)
    throw new TypeError('Duplicate provisional measurement identity');
  return Object.freeze({async findPage(raw:MeasurementPageRequest&{realm:string;clientId:string}){
    const realm=checkedOutput(catalogueRealmSchema,raw.realm);
    const request=measurementPageRequestSchema.safeParse({selector:raw.selector,from:raw.from,to:raw.to,limit:raw.limit,after:raw.after});
    if(!request.success)throw new ApplicationError('INTERNAL_ERROR');
    const sorted=rows.filter(row=>row.realm===realm&&row.clientId===raw.clientId&&selected(row,request.data.selector)&&
      row.attributedAt>=request.data.from&&row.attributedAt<request.data.to&&(!request.data.after||
        row.attributedAt<request.data.after.attributedAt||(row.attributedAt===request.data.after.attributedAt&&row.id<request.data.after.id)))
      .sort((a,b)=>b.attributedAt-a.attributedAt||b.id.localeCompare(a.id));
    const items=sorted.slice(0,request.data.limit),hasMore=sorted.length>items.length,last=items.at(-1);
    return Object.freeze({items:Object.freeze(items),next:hasMore&&last?Object.freeze({attributedAt:last.attributedAt,id:last.id}):null});
  }});
}
