import { z } from 'zod';
import { ApplicationError } from '../errors/application.error.js';
import { callPort, checkedOutput } from '../auth/validation.js';
import type { MeasurementAttributionPorts, AttributionResult, TrustedMeasurementEvent } from '../measurements/contracts.js';
import { attributionWindowSchema, resolvedPhysicalDeviceSchema, temporalDecisionSchema, trustedMeasurementEventSchema } from '../measurements/schemas.js';
import { catalogueRealmSchema } from '../auth/identity-catalogue.schemas.js';

export function createMeasurementAttributionService(ports: MeasurementAttributionPorts, options:{realm:string}) {
  if(typeof ports?.devices?.findExact!=='function'||typeof ports?.associations?.findAt!=='function'||
    typeof ports?.temporal?.select!=='function'||typeof ports?.catalogue?.accepts!=='function') throw new TypeError('Measurement attribution ports are incomplete');
  const realmResult=catalogueRealmSchema.safeParse(options?.realm);if(!realmResult.success)throw new TypeError('Invalid measurement realm');const realm=realmResult.data;
  const signature=(value:unknown)=>JSON.stringify(value);
  const quarantine=(eventId:string,reason:Extract<AttributionResult,{status:'quarantined'}>['reason']):AttributionResult=>Object.freeze({status:'quarantined',eventId,reason});
  async function resolve(input:unknown):Promise<AttributionResult>{
    let event:TrustedMeasurementEvent;
    try{const parsed=trustedMeasurementEventSchema.safeParse(input);if(!parsed.success)throw new Error();event=parsed.data;}catch{throw new ApplicationError('VALIDATION_ERROR');}
    const devices=checkedOutput(z.array(resolvedPhysicalDeviceSchema).max(2),await callPort(()=>ports.devices.findExact({sourceId:event.sourceId,device:event.device,limit:2})));
    if(devices.length===0)return quarantine(event.eventId,'unknown-device');
    if(devices.length!==1||devices[0].sourceId!==event.sourceId||devices[0].device.kind!==event.device.kind||devices[0].device.value!==event.device.value)return quarantine(event.eventId,'ambiguous-device');
    const device=devices[0];
    if(device.verification!=='verified')return quarantine(event.eventId,'unverified-device');
    if(device.lifecycle!=='active')return quarantine(event.eventId,'inactive-device');
    const temporal=checkedOutput(temporalDecisionSchema,await callPort(()=>ports.temporal.select(event)));
    if(temporal.status==='untrusted')return quarantine(event.eventId,'untrusted-clock');
    if(temporal.at>event.persistedAt)throw new ApplicationError('INTERNAL_ERROR');
    const accepted=checkedOutput(z.boolean(),await callPort(()=>ports.catalogue.accepts({magnitude:event.magnitude,unit:event.unit,provenance:event.provenance})));
    if(!accepted)return quarantine(event.eventId,'invalid-catalogue');
    const windows=checkedOutput(z.array(attributionWindowSchema).max(2),await callPort(()=>ports.associations.findAt({realm,physicalDeviceId:device.id,at:temporal.at,limit:2})));
    if(windows.some(row=>row.realm!==realm||row.physicalDeviceId!==device.id))throw new ApplicationError('INTERNAL_ERROR');
    const matching=windows.filter(row=>row.realm===realm&&row.physicalDeviceId===device.id&&row.validFrom<=temporal.at&&(row.validTo===null||temporal.at<row.validTo));
    if(matching.length===0)return quarantine(event.eventId,'no-window');
    if(matching.length!==1)return quarantine(event.eventId,'overlap');
    const row=matching[0];
    const currentDevices=checkedOutput(z.array(resolvedPhysicalDeviceSchema).max(2),await callPort(()=>ports.devices.findExact({sourceId:event.sourceId,device:event.device,limit:2})));
    const currentWindows=checkedOutput(z.array(attributionWindowSchema).max(2),await callPort(()=>ports.associations.findAt({realm,physicalDeviceId:device.id,at:temporal.at,limit:2})));
    if(signature(currentDevices)!==signature(devices)||signature(currentWindows)!==signature(windows))throw new ApplicationError('CONFLICT');
    const snapshot=Object.freeze({...event,device:Object.freeze({...event.device}),metadata:Object.freeze({...event.metadata})});
    return Object.freeze({status:'verified',event:snapshot,attributedAt:temporal.at,clock:temporal.clock,
      physicalDeviceId:device.id,realm:row.realm,clientId:row.clientId,fieldId:row.fieldId,areaId:row.areaId,
      sensorId:row.sensorId,associationId:row.id,associationRevision:row.revision});
  }
  return Object.freeze({resolve});
}
