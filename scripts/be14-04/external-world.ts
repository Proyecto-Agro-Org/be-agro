// BE14-04 — the "external world": the SAME conformance world (real BE13 service/router + HTTP fault injection) but MQTT is observed on a REAL broker (ExternalMqttObserver)
// and broker faults are injected by the ExternalFaultController. The catalog is unchanged; only the surface behind `w.publishes`, `w.connects`, `w.setMqtt` and `w.dropConnections` differs.
import { createWorld, type MqttMode, type World } from '../be14-03/world.js';
import { createObserver, type Observer, type ObservationSink, type ObservationSource } from './observer.js';
import { FaultError, type FaultController } from './fault-controller.js';

export interface ExternalWorldKit {
  worldFactory: (technicalKey: string) => Promise<World>;
  /** Source sink: delegates to the CURRENT world's observer (each conformance session gets a fresh observer, the infrastructure stays up). */
  sink: ObservationSink; current(): Observer | null; currentWorld(): World | null; all(): Observer[];
  faults: FaultController; unsupportedFaults(): string[];
}
export function createExternalWorldKit(o: { runId: string; faults: FaultController; observerFactory?: (technicalKey: string, onPublish: (bytes: Buffer, clientId: string) => void) => Observer; ingestObserved?: boolean }): ExternalWorldKit {
  let cur: Observer | null = null, curWorld: World | null = null; const all: Observer[] = []; const unsupported = new Set<string>();
  const sink: ObservationSink = { connect: c => cur?.sink.connect(c), disconnect: c => cur?.sink.disconnect(c), publish: p => cur?.sink.publish(p) };
  return {
    sink, current: () => cur, currentWorld: () => curWorld, all: () => all, faults: o.faults, unsupportedFaults: () => [...unsupported],
    async worldFactory(technicalKey) {
      let worldRef: World | null = null, deliver = true, brokerIsDown = false;
      const obs = createObserver({ runId: o.runId, technicalIdentity: technicalKey, onPublish: p => { if (o.ingestObserved !== false && deliver && worldRef && p.clientId === technicalKey) worldRef.backendReceives(p.bytes); } });
      cur = obs; all.push(obs);
      const unsupportedFault = (name: string): never => { unsupported.add(name); throw new FaultError('FAULT_CAPABILITY_ABSENT', name + ' cannot be injected on a real external broker'); };
      const surface = {
        publishes: () => obs.publishRecords(), connects: () => obs.connectRecords(), maxConcurrent: () => obs.connections().maxConcurrent,
        async setMqtt(m: MqttMode) {
          if (m === 'drop-before-puback') return unsupportedFault('drop-before-puback');                // the exact instant between broker acceptance and PUBACK cannot be controlled from outside a real broker
          if (m === 'down') { if (!brokerIsDown) { await o.faults.brokerDown(); brokerIsDown = true; } return; }
          if (brokerIsDown) { await o.faults.brokerUp(); brokerIsDown = false; }
          deliver = m === 'normal';                                                                      // 'puback-no-delivery': the broker accepts, the backend never receives
        },
        async dropConnections() { await o.faults.disconnectClient(technicalKey); },
      };
      const w = createWorld({ technicalKey, externalMqtt: surface }); worldRef = w; curWorld = w;
      const stop = w.stop.bind(w); w.stop = async () => { try { if (brokerIsDown) { await o.faults.brokerUp(); brokerIsDown = false; } } catch { /* reported by the runner via faults.log */ } await stop(); };
      return w;
    },
  };
}
export type { ObservationSource };
