import { createBe12IdentityPorts } from '../adapters/ingestion-identity.adapters.js';
import { isBlockingPlaceholder } from '../adapters/ingestion-production-placeholders.js';
import { createIngestProvenanceAuthority } from '../iot/ingest-provenance.authority.js';
import { createProtectedIngestMapper } from '../iot/protected-ingest.mapper.js';
import { catalogueRealmSchema } from '../auth/identity-catalogue.schemas.js';
import type {
  IngestionRootReadiness,
  DependencyReadiness,
  MeasurementIngestionRoot,
  MeasurementIngestionRootDependencies,
  MeasurementIngestionRootResult,
} from '../iot/ingestion-root.contracts.js';
import type { TrustGateRealm } from '../iot/trust-gate.contracts.js';
import { createMeasurementAttributionService } from './measurement-attribution.service.js';
import { createPersistentMeasurementIngestionComposition } from './measurement-ingestion-composition.service.js';

// BE13-07 — composition root. The ONLY high-level factory intended to assemble
// BE13-02 → BE13-06 for a future runtime. Not mounted in app.ts; no routes,
// consumers, workers or cron. It reads no environment variables and has no
// permissive mode: every dependency is mandatory and production placeholders
// block. It does not authenticate hardware, EMQX or anything else: it only
// decides which injected implementations are treated as authorities.

const requiredMethods: ReadonlyArray<readonly [string, (d: MeasurementIngestionRootDependencies) => unknown, string]> = [
  ['realmAuthority', d => d.realmAuthority, 'authorizedRealm'],
  ['provenanceVerifier', d => d.provenanceVerifier, 'verify'],
  ['hardware', d => d.hardware, 'verify'],
  ['temporal', d => d.temporal, 'decide'],
  ['catalogue', d => d.catalogue, 'evaluate'],
  ['policies.declaredAt', d => d.policies?.declaredAt, 'decide'],
  ['policies.clock', d => d.policies?.clock, 'decide'],
  ['policies.missingReason', d => d.policies?.missingReason, 'decide'],
  ['policies.persistenceTime', d => d.policies?.persistenceTime, 'decide'],
  ['identityStore', d => d.identityStore, 'findDevicesByKey'],
  ['identityStore.associations', d => d.identityStore, 'findAssociationsAt'],
  ['persistence', d => d.persistence, 'persistAtomically'],
  ['persistence.lookup', d => d.persistence, 'lookup'],
  ['be12.temporal', d => d.be12?.temporal, 'select'],
  ['be12.catalogue', d => d.be12?.catalogue, 'accepts'],
];

const hasMethod = (value: unknown, method: string) =>
  typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>)[method] === 'function';

function acknowledged(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as Record<string, unknown>).mode === 'current-state-only' &&
    (value as Record<string, unknown>).limitation === 'DEVICE_STATUS_HISTORY_REQUIRED' && Object.keys(value).length === 2;
}

// Static, local diagnosis (no IO, no secrets). Not a health endpoint.
export function describeIngestionRootReadiness(input: unknown): IngestionRootReadiness {
  const deps = (typeof input === 'object' && input !== null ? input : {}) as MeasurementIngestionRootDependencies;
  const dependencies: Record<string, DependencyReadiness> = {};
  for (const [name, pick, method] of requiredMethods) {
    let value: unknown;
    try { value = pick(deps); } catch { value = undefined; }
    const base = name.split('.').length > 1 && (name.startsWith('identityStore') || name.startsWith('persistence')) ? name.split('.')[0] : name;
    if (!hasMethod(value, method)) dependencies[base] = 'MISSING';
    else if (dependencies[base] !== 'MISSING') dependencies[base] = isBlockingPlaceholder(value) || (name.startsWith('be12.') && isBlockingPlaceholder(deps.be12))
      ? 'BLOCKED' : 'INJECTED_UNVERIFIED';
  }
  let ack = false;
  try { ack = acknowledged(deps.deviceStatusHistory); } catch { ack = false; }
  dependencies.deviceStatusHistory = ack ? 'INJECTED_UNVERIFIED' : 'MISSING';
  const overall = Object.values(dependencies).some(state => state !== 'INJECTED_UNVERIFIED') ? 'BLOCKED' : 'READY_FOR_TEST';
  return Object.freeze({ overall, productionReady: false as const, dependencies: Object.freeze(dependencies), limitations: Object.freeze(['DEVICE_STATUS_HISTORY_REQUIRED'] as const) });
}

export function createMeasurementIngestionRoot(deps: MeasurementIngestionRootDependencies): MeasurementIngestionRoot {
  if (typeof deps !== 'object' || deps === null) throw new TypeError('Ingestion root dependencies required');
  for (const [name, pick, method] of requiredMethods) {
    let value: unknown;
    try { value = pick(deps); } catch { value = undefined; }
    if (!hasMethod(value, method)) throw new TypeError(`Missing ingestion root dependency: ${name}`);
  }
  if (!acknowledged(deps.deviceStatusHistory)) throw new TypeError('Missing ingestion root dependency: deviceStatusHistory acknowledgement');

  // Realm: read once from the authorized context, never from the document.
  let realmValue: unknown;
  try { realmValue = deps.realmAuthority.authorizedRealm(); } catch { throw new TypeError('Realm authority failed'); }
  const realmResult = catalogueRealmSchema.safeParse(realmValue);
  if (!realmResult.success) throw new TypeError('Realm authority returned an invalid realm');
  const realm: TrustGateRealm = realmResult.data;

  // BE13-02: provenance authority + mapper owned by the root.
  const provenance = createIngestProvenanceAuthority(deps.provenanceVerifier);
  const mapper = createProtectedIngestMapper(provenance.authority);

  // BE-12 over the same realm-scoped identity store.
  const be12 = createMeasurementAttributionService({ ...createBe12IdentityPorts(deps.identityStore, realm),
    temporal: deps.be12.temporal, catalogue: deps.be12.catalogue } as never, { realm });

  // BE13-03..06.
  const composition = createPersistentMeasurementIngestionComposition({
    realmContext: { realm }, identityStore: deps.identityStore, temporal: deps.temporal, hardware: deps.hardware, catalogue: deps.catalogue,
    policies: { clock: deps.policies.clock, declaredAt: deps.policies.declaredAt, missingReason: deps.policies.missingReason, persistenceTime: deps.policies.persistenceTime },
    persistence: deps.persistence, be12, ...(deps.authorityTimeoutMs === undefined ? {} : { authorityTimeoutMs: deps.authorityTimeoutMs }),
  });

  async function ingest(protectedDocument: unknown, provenanceEvidence: unknown, selection: { readonly field: string }): Promise<MeasurementIngestionRootResult> {
    const capability = provenance.attest(provenanceEvidence);
    const mapped = mapper.map(protectedDocument, capability ?? undefined);
    if (mapped.status !== 'candidate') return Object.freeze({ status: 'quarantined', reason: 'mapper-rejected', cause: mapped.reason, eventId: null });
    return composition.ingest(mapped, selection);
  }

  return Object.freeze({ ingest, realm });
}
