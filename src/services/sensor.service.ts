import type { AuthorizationContext } from '../auth/contracts.js';
import { ApplicationError } from '../errors/application.error.js';
import type { AuthorizationService } from './authorization.service.js';
import type { AreaReassignmentInput, AssociationCloseInput, AssociationCreateInput, DeviceCreateInput, DeviceIdentityVerifier, DeviceReassignmentInput, LifecycleInput, SensorCreateInput, SensorPatchInput, SensorRepository } from '../sensors/contracts.js';

export function createSensorService(options: { authorization: AuthorizationService; repository: SensorRepository; verifier: DeviceIdentityVerifier; realm: string }) {
  if (typeof options?.repository?.createSensor !== 'function' || typeof options?.verifier?.verify !== 'function') throw new TypeError('Sensor service ports are incomplete');
  const scope = (context: AuthorizationContext) => { options.authorization.assertContext(context); return { realm: options.realm, clientId: context.clientId }; };
  async function verifiedDevice(input: DeviceCreateInput) {
    try {
      const result = await options.verifier.verify(input.sourceId, input.key);
      if (!result || (result.status !== 'verified' && result.status !== 'unverified')) throw new ApplicationError('DEPENDENCY_UNAVAILABLE');
      return result;
    } catch (error) { if (error instanceof ApplicationError) throw error; throw new ApplicationError('DEPENDENCY_UNAVAILABLE'); }
  }
  return Object.freeze({
    list: (context: AuthorizationContext, page: { after?: string; limit: number }) => options.repository.listSensors(scope(context),page),
    get: (context: AuthorizationContext,id:string) => options.repository.getSensor(scope(context),id),
    create: (context: AuthorizationContext,input:SensorCreateInput) => options.repository.createSensor(scope(context),input),
    patch: (context: AuthorizationContext,id:string,input:SensorPatchInput) => options.repository.patchSensor(scope(context),id,input),
    deactivate: (context: AuthorizationContext,id:string,input:LifecycleInput) => options.repository.setSensorLifecycle(scope(context),id,'inactive',input),
    decommission: (context: AuthorizationContext,id:string,input:LifecycleInput) => options.repository.setSensorLifecycle(scope(context),id,'decommissioned',input),
    reassignArea: (context: AuthorizationContext,input:AreaReassignmentInput) => options.repository.reassignSensorArea(scope(context),input),
    async registerDevice(context:AuthorizationContext,input:DeviceCreateInput){const verification=await verifiedDevice(input);options.authorization.assertContext(context);return options.repository.createDevice(scope(context),input,verification);},
    async refreshDeviceVerification(context:AuthorizationContext,id:string,version:number){const current=await options.repository.getDevice(scope(context),id);const verification=await verifiedDevice({sourceId:current.sourceId,key:current.key});options.authorization.assertContext(context);return options.repository.setDeviceVerification(scope(context),id,version,verification);},
    getDevice: (context:AuthorizationContext,id:string)=>options.repository.getDevice(scope(context),id),
    deactivateDevice: (context:AuthorizationContext,id:string,input:LifecycleInput)=>options.repository.setDeviceLifecycle(scope(context),id,'inactive',input),
    decommissionDevice: (context:AuthorizationContext,id:string,input:LifecycleInput)=>options.repository.setDeviceLifecycle(scope(context),id,'decommissioned',input),
    associate: (context:AuthorizationContext,input:AssociationCreateInput)=>options.repository.createAssociation(scope(context),input),
    closeAssociation: (context:AuthorizationContext,input:AssociationCloseInput)=>options.repository.closeAssociation(scope(context),input),
    reassignDevice: (context:AuthorizationContext,input:DeviceReassignmentInput)=>options.repository.reassignDevice(scope(context),input),
    associations: (context:AuthorizationContext,sensorId:string)=>options.repository.listAssociations(scope(context),sensorId),
    areaHistory: (context:AuthorizationContext,sensorId:string)=>options.repository.listAreaAssignments(scope(context),sensorId),
  });
}
