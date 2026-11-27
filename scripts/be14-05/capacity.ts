// BE14-05 — capacity / storage calculator (TOOLING ONLY). It does NOT choose hardware and contains NO productive values: every input is supplied by the caller.
//   minimum outbox storage = eventsPerDay × offlineDays × (avgPayloadBytes + metadataOverhead) × safetyFactor
//   network bytes/day      = eventsPerDay × (publishOverhead + payloadBytes + reconciliationOverhead) × (1 + retryFactor)
import { pathToFileURL } from 'node:url';

export interface StorageInput { eventsPerDay: number; avgPayloadBytes: number; offlineDays: number; metadataOverheadBytes: number; safetyFactor: number }
export interface StorageResult { events: number; recordBytes: number; requiredBytes: number; requiredKiB: number; requiredMiB: number; estimatedRecordCount: number }
export interface NetworkInput { eventsPerDay: number; avgPayloadBytes: number; publishOverheadBytes: number; reconciliationOverheadBytes: number; retryFactor: number }
export interface NetworkResult { bytesPerEvent: number; bytesPerDay: number; bytesPerSecondAverage: number }

const nonNeg = (name: string, v: unknown): number => { if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new RangeError('INVALID_INPUT:' + name); return v; };
const round = (v: number) => Math.round(v * 1000) / 1000;

export function storageRequirement(i: StorageInput): StorageResult {
  const eventsPerDay = nonNeg('eventsPerDay', i.eventsPerDay), payload = nonNeg('avgPayloadBytes', i.avgPayloadBytes), days = nonNeg('offlineDays', i.offlineDays), meta = nonNeg('metadataOverheadBytes', i.metadataOverheadBytes), safety = nonNeg('safetyFactor', i.safetyFactor);
  if (safety < 1) throw new RangeError('INVALID_INPUT:safetyFactor must be >= 1');
  const events = eventsPerDay * days, recordBytes = payload + meta, requiredBytes = Math.ceil(events * recordBytes * safety);
  return { events: round(events), recordBytes, requiredBytes, requiredKiB: round(requiredBytes / 1024), requiredMiB: round(requiredBytes / 1048576), estimatedRecordCount: Math.ceil(events * safety) };
}
export function networkRequirement(i: NetworkInput): NetworkResult {
  const eventsPerDay = nonNeg('eventsPerDay', i.eventsPerDay), payload = nonNeg('avgPayloadBytes', i.avgPayloadBytes), pub = nonNeg('publishOverheadBytes', i.publishOverheadBytes), rec = nonNeg('reconciliationOverheadBytes', i.reconciliationOverheadBytes), retry = nonNeg('retryFactor', i.retryFactor);
  const bytesPerEvent = (pub + payload + rec) * (1 + retry); const bytesPerDay = eventsPerDay * bytesPerEvent;
  return { bytesPerEvent: round(bytesPerEvent), bytesPerDay: Math.ceil(bytesPerDay), bytesPerSecondAverage: round(bytesPerDay / 86400) };
}
// CLI:  node dist/scripts/be14-05/capacity.js '{"eventsPerDay":..,"avgPayloadBytes":..,"offlineDays":..,"metadataOverheadBytes":..,"safetyFactor":..}'
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { const i = JSON.parse(process.argv[2] ?? '{}'); console.log(JSON.stringify({ storage: 'offlineDays' in i ? storageRequirement(i) : undefined, network: 'publishOverheadBytes' in i ? networkRequirement(i) : undefined }, null, 1)); }
  catch (e) { console.error((e as Error).message); process.exitCode = 2; }
}
