import { AsyncLocalStorage } from 'node:async_hooks';

// BE13-11M — reconcilable quarantine scope. While a VERIFIED delivery is being ingested, the boundary publishes the facts it already proved
// (authenticated principal, hash of the exact bytes, validated declared eventId). The quarantine store reads them when it records an entry, so a NEW quarantine
// row can be reconciled by the publisher that owns it without ever trusting the payload for scope. Rows written before 11M simply lack these fields (legacy-safe).
// The context never changes the quarantine identity (quarantineId), so deduplication is unchanged.
export interface QuarantineReconcileScope { readonly principalReference: string; readonly payloadSha256: string; readonly declaredEventId: string }
const storage = new AsyncLocalStorage<QuarantineReconcileScope>();
export const runWithQuarantineScope = <T>(scope: QuarantineReconcileScope, work: () => Promise<T>): Promise<T> => storage.run(Object.freeze({ ...scope }), work);
export const currentQuarantineScope = (): QuarantineReconcileScope | undefined => storage.getStore();
