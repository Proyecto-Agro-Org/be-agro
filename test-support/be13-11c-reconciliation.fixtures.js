// SINTETICO — BE13-11C TEST_ONLY reconciliation fixtures. In-memory store with the SAME semantics as the Mongo store
// (state in a separate map; claim = CAS; complete = fenced; ages measured against the inbox's synthetic "database clock").
// Every number below is a TEST_ONLY value, NOT a production proposal.
import { boundarySetup, createInMemoryBrokerInbox, delivery } from './be13-11a-broker.fixtures.js';
import { createBrokerInboxReconciler } from '../dist/src/services/broker-inbox-reconciliation.service.js';

export const TEST_ONLY_POLICY = Object.freeze({ mode: 'TEST_ONLY', minAgeMs: 1000, claimLeaseMs: 5000, maxBatch: 50 });

export function createInMemoryReconciliationStore(inbox, realm = 'test') {
  const states = new Map(); let seq = 0;
  const rawIn = (r, id) => r === realm && inbox.rows.has(id) && inbox.rows.get(id).realm === realm;
  const same = r => { if (r !== realm) throw new Error('RECONCILIATION_REALM_MISMATCH'); };
  const store = {
    states, failing: false, hooks: {},
    async markReceipted({ realm: r, inboxId }) {
      same(r); if (store.failing) throw new Error('store down');
      if (!rawIn(r, inboxId)) throw new Error('RECONCILIATION_RAW_NOT_FOUND');
      if (!states.has(inboxId)) states.set(inboxId, { status: 'receipted', version: 1 });
    },
    async completeFromReceipt({ realm: r, inboxId }) {
      same(r); const s = states.get(inboxId);
      if (!s || s.status !== 'receipted' || s.version !== 1) return false;
      Object.assign(s, { status: 'completed', version: 2, outcome: 'admission-processed' }); return true;
    },
    async listCandidates({ realm: r, minAgeMs, limit }) {
      same(r);
      return [...inbox.rows.values()].filter(x => x.realm === realm && x.rawPersistedAt <= inbox.now() - minAgeMs && !states.has(x.inboxId))
        .sort((a, b) => a.rawPersistedAt - b.rawPersistedAt).slice(0, limit).map(x => ({ inboxId: x.inboxId, rawPersistedAt: x.rawPersistedAt }));
    },
    async count({ realm: r, limit }) {
      same(r); const c = { absent: 0, receipted: 0, claimed: 0, completed: 0 };
      for (const x of [...inbox.rows.values()].filter(x => x.realm === realm).slice(0, limit)) c[states.get(x.inboxId)?.status ?? 'absent'] += 1;
      return c;
    },
    async claim({ realm: r, inboxId, claimLeaseMs }) {
      same(r); if (store.failing) throw new Error('store down');
      if (!rawIn(r, inboxId)) return null;
      await Promise.resolve(); // yield: concurrent claimers interleave; the check-and-set below is atomic (single JS turn)
      const s = states.get(inboxId), token = (++seq).toString(16).padStart(32, '0');
      if (!s) { states.set(inboxId, { status: 'claimed', version: 1, token, claimedAt: inbox.now() }); return { inboxId, token, version: 1 }; }
      if (s.status === 'claimed' && s.claimedAt + claimLeaseMs <= inbox.now()) { Object.assign(s, { version: s.version + 1, token, claimedAt: inbox.now() }); return { inboxId, token, version: s.version }; }
      return null;
    },
    async complete({ realm: r, claim, outcome }) {
      same(r); if (store.failing) throw new Error('store down');
      const s = states.get(claim.inboxId);
      if (!s || s.status !== 'claimed' || s.token !== claim.token || s.version !== claim.version) return false;
      Object.assign(s, { status: 'completed', version: s.version + 1, outcome }); return true;
    },
    async getState({ realm: r, inboxId }) { same(r); const s = states.get(inboxId); return s ? { status: s.status, version: s.version, outcome: s.outcome ?? null } : null; },
  };
  return store;
}

// Boundary + inbox + reconciliation store + reconciler (TEST_ONLY policy unless overridden).
export async function reconciliationSetup({ policy = TEST_ONLY_POLICY, ...rest } = {}) {
  const inbox = createInMemoryBrokerInbox('test');
  const store = createInMemoryReconciliationStore(inbox);
  const s = await boundarySetup({ durableInbox: inbox, ...rest, extra: { ...(rest.extra ?? {}), reconciliationStore: store } });
  const reconciler = createBrokerInboxReconciler({ realm: 'test', admission: s.admission, reconciliationStore: store, reconciliationPolicy: policy,
    audit: s.deps.audit, metrics: s.deps.metrics, alerts: s.deps.alerts });
  // N4 helper: persist a delivery whose acknowledgement is lost -> record stored, no receipt, no marker, no processing.
  const orphan = async (d = delivery()) => {
    inbox.loseAck = true;
    const r = await s.admission.admit(d, { mode: 'persist-and-process' });
    inbox.loseAck = false;
    return r;
  };
  const rebuild = (reconciliationPolicy, extra = {}) => createBrokerInboxReconciler({ realm: 'test', admission: s.admission, reconciliationStore: store, reconciliationPolicy,
    audit: s.deps.audit, metrics: s.deps.metrics, alerts: s.deps.alerts, ...extra });
  return { ...s, store, reconciler, orphan, rebuild };
}
export { delivery };
