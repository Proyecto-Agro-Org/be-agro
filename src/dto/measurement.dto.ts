import type { AttributedMeasurement, MeasurementPage } from '../measurements/contracts.js';

export interface MeasurementResponse {
  readonly id:string;readonly eventId:string;readonly sensorId:string;readonly physicalDeviceId:string;
  readonly magnitude:string;readonly unit:string;readonly value:number|null;readonly missingReason:string|null;
  readonly provenance:string;readonly receivedAt:string;readonly declaredAt:string|null;readonly attributedAt:string;
}
export interface MeasurementHistoryResponse {readonly items:readonly MeasurementResponse[];readonly next:string|null}
const iso=(value:number)=>new Date(value).toISOString();
export function measurementResponse(row:AttributedMeasurement):MeasurementResponse{return Object.freeze({id:row.id,eventId:row.eventId,
  sensorId:row.sensorId,physicalDeviceId:row.physicalDeviceId,magnitude:row.magnitude,unit:row.unit,value:row.value,
  missingReason:row.missingReason,provenance:row.provenance,receivedAt:iso(row.receivedAt),declaredAt:row.declaredAt===null?null:iso(row.declaredAt),attributedAt:iso(row.attributedAt)});}
export function measurementHistoryResponse(page:MeasurementPage):MeasurementHistoryResponse{return Object.freeze({items:Object.freeze(page.items.map(measurementResponse)),
  next:page.next?Buffer.from(JSON.stringify(page.next)).toString('base64url'):null});}
