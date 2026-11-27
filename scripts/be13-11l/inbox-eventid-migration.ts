// BE13-11L — Durable Inbox eventId migration (LOCAL / DISPOSABLE ONLY). DEFAULT = DRY-RUN: it only inspects and prints a plan.
// `--apply` additionally needs AGRO_MIGRATION_ENABLE=LOCAL_DISPOSABLE_ONLY and a loopback MongoDB URI; it REFUSES Atlas (`mongodb+srv`, `*.mongodb.net`) and any
// remote host. Running it against a real database is a human-gated operation that this script does not perform.
//
// What it does (in order, each step idempotent):
//   1. collMod: allow the optional `eventId` property in the closed inbox validator;
//   2. createIndex inbox_realm_source_event { realm, sourceId, eventId, rawPersistedAt:-1 };
//   3. backfill eventId ONLY for LEGACY records whose immutable raw bytes (a) hash to the stored rawPayloadSha256 and (b) carry a valid eventId.
//      Records that cannot be proven are left untouched and reported as unbackfillable. Nothing is ever guessed.
// The raw evidence fields (rawPayload, rawPayloadSha256, fingerprints, timestamps) are never modified; the only write is `$set: { eventId }` guarded by `eventId: { $exists: false }`
// and by the stored hash, so a concurrent change makes the update a no-op.
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { mongo } from 'mongoose';
type Db = mongo.Db; type Collection = mongo.Collection;
import { INBOX_EVENT_INDEX_NAME, brokerInboxCollection, brokerInboxIndexes, brokerInboxValidator } from '../../src/models/broker-inbox.models.js';

const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/;
export type LegacyClass =
  | { readonly kind: 'has-eventid'; readonly eventId: string }
  | { readonly kind: 'backfillable'; readonly eventId: string }
  | { readonly kind: 'unbackfillable'; readonly reason: 'payload-not-json' | 'eventid-missing' | 'eventid-invalid' | 'hash-mismatch' | 'payload-unreadable' };

/** Pure classification of one stored inbox document. */
export function classifyInboxRecord(doc: { eventId?: unknown; rawPayload?: unknown; rawPayloadSha256?: unknown }): LegacyClass {
  if (typeof doc.eventId === 'string' && EVENT_ID.test(doc.eventId)) return { kind: 'has-eventid', eventId: doc.eventId };
  const raw = doc.rawPayload, buf = raw && typeof raw === 'object' && 'buffer' in raw ? (raw as { buffer: Uint8Array }).buffer : null;
  if (!buf) return { kind: 'unbackfillable', reason: 'payload-unreadable' };
  const bytes = Buffer.from(buf);
  if (createHash('sha256').update(bytes).digest('hex') !== doc.rawPayloadSha256) return { kind: 'unbackfillable', reason: 'hash-mismatch' };
  let parsed: unknown; try { parsed = JSON.parse(bytes.toString('utf8')); } catch { return { kind: 'unbackfillable', reason: 'payload-not-json' }; }
  const id = parsed && typeof parsed === 'object' ? (parsed as { eventId?: unknown }).eventId : undefined;
  if (id === undefined || id === null) return { kind: 'unbackfillable', reason: 'eventid-missing' };
  return typeof id === 'string' && EVENT_ID.test(id) ? { kind: 'backfillable', eventId: id } : { kind: 'unbackfillable', reason: 'eventid-invalid' };
}

export interface MigrationArgs { readonly apply: boolean; readonly uri: string | null; readonly prefix: string | null; readonly batch: number }
/** Default is dry-run. `--apply` is the ONLY way to write and is never implied. */
export function parseArgs(argv: readonly string[]): MigrationArgs {
  const get = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] ?? null : null; };
  return { apply: argv.includes('--apply') && !argv.includes('--dry-run'), uri: get('--uri'), prefix: get('--prefix'), batch: Math.min(5000, Math.max(1, Number(get('--batch') ?? 500) || 500)) };
}

/** Refuses anything that is not a loopback MongoDB. Atlas SRV and *.mongodb.net are never allowed. */
export function assertLocalOnly(uri: string | null, env: Record<string, string | undefined>): void {
  if (!uri) throw new Error('MIGRATION_URI_REQUIRED');
  if (env.AGRO_MIGRATION_ENABLE !== 'LOCAL_DISPOSABLE_ONLY') throw new Error('MIGRATION_APPLY_NOT_ENABLED');
  if (/^mongodb\+srv:/i.test(uri) || /mongodb\.net/i.test(uri)) throw new Error('MIGRATION_ATLAS_FORBIDDEN');
  const hosts = uri.replace(/^mongodb:\/\/(?:[^@/]*@)?/i, '').split('/')[0]!.split(',').map(h => h.replace(/:\d+$/, '').toLowerCase());
  if (hosts.length === 0 || !hosts.every(h => h === '127.0.0.1' || h === 'localhost' || h === '[::1]')) throw new Error('MIGRATION_REMOTE_HOST_FORBIDDEN');
}

export interface MigrationReport {
  readonly mode: 'dry-run' | 'apply'; readonly collection: string; readonly total: number; readonly withEventId: number; readonly legacy: number; readonly backfillable: number;
  readonly unbackfillable: Readonly<Record<string, number>>; readonly validatorAllowsEventId: boolean; readonly indexPresent: boolean;
  readonly proposals: readonly string[]; readonly applied: { readonly collMod: boolean; readonly index: boolean; readonly backfilled: number } | null;
}

async function state(db: Db, name: string) {
  const info = (await db.listCollections({ name }).toArray())[0] as { options?: { validator?: { $jsonSchema?: { properties?: Record<string, unknown> } } } } | undefined;
  if (!info) throw new Error('MIGRATION_COLLECTION_NOT_FOUND');
  const indexes = await db.collection(name).indexes().catch(() => []);
  return { validatorAllowsEventId: Boolean(info.options?.validator?.$jsonSchema?.properties?.eventId), indexPresent: indexes.some(i => i.name === INBOX_EVENT_INDEX_NAME) };
}

export async function runMigration(db: Db, prefix: string, options: { apply: boolean; batch?: number }): Promise<MigrationReport> {
  const name = brokerInboxCollection(prefix), rows: Collection = db.collection(name), batch = options.batch ?? 500;
  const before = await state(db, name);
  let total = 0, withEventId = 0, backfillable = 0; const unbackfillable: Record<string, number> = {}; const pending: { _id: unknown; eventId: string; sha: string }[] = [];
  const cursor = rows.find({}, { projection: { eventId: 1, rawPayload: 1, rawPayloadSha256: 1 } });
  for await (const doc of cursor) {
    total += 1; const c = classifyInboxRecord(doc as never);
    if (c.kind === 'has-eventid') withEventId += 1;
    else if (c.kind === 'backfillable') { backfillable += 1; pending.push({ _id: doc._id, eventId: c.eventId, sha: String(doc.rawPayloadSha256) }); }
    else unbackfillable[c.reason] = (unbackfillable[c.reason] ?? 0) + 1;
  }
  const proposals = [...(before.validatorAllowsEventId ? [] : ['collMod: allow optional `eventId` in the inbox validator']), ...(before.indexPresent ? [] : [`createIndex ${INBOX_EVENT_INDEX_NAME} ${JSON.stringify(brokerInboxIndexes[1].key)}`]),
    ...(backfillable > 0 ? [`backfill eventId on ${backfillable} legacy record(s) with a proven hash and a valid eventId`] : [])];
  let applied: MigrationReport['applied'] = null;
  if (options.apply) {
    let collMod = false, index = false, backfilled = 0;
    if (!before.validatorAllowsEventId) { await db.command({ collMod: name, validator: brokerInboxValidator, validationLevel: 'strict', validationAction: 'error' }); collMod = true; }
    if (!before.indexPresent) { await rows.createIndex(brokerInboxIndexes[1].key as never, { name: INBOX_EVENT_INDEX_NAME, collation: { locale: 'simple' } } as never); index = true; }
    for (let i = 0; i < pending.length; i += batch) for (const p of pending.slice(i, i + batch)) {
      const r = await rows.updateOne({ _id: p._id as never, eventId: { $exists: false }, rawPayloadSha256: p.sha } as never, { $set: { eventId: p.eventId } }, { writeConcern: { w: 'majority', j: true } } as never);
      backfilled += r.modifiedCount;
    }
    applied = { collMod, index, backfilled };
  }
  const after = options.apply ? await state(db, name) : before;
  return { mode: options.apply ? 'apply' : 'dry-run', collection: name, total, withEventId, legacy: total - withEventId, backfillable, unbackfillable, validatorAllowsEventId: after.validatorAllowsEventId, indexPresent: after.indexPresent, proposals, applied };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.apply) assertLocalOnly(args.uri, process.env);
  if (!args.uri || !args.prefix) throw new Error('usage: --uri <mongodb://127.0.0.1:port/db> --prefix <ingest prefix> [--apply]  (default: dry-run)');
  const client = new mongo.MongoClient(args.uri, { serverSelectionTimeoutMS: 5000 });
  try { await client.connect(); console.log(JSON.stringify(await runMigration(client.db(), args.prefix, { apply: args.apply, batch: args.batch }), null, 1)); } finally { await client.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error('MIGRATION_FAILED', (e as Error).message); process.exit(1); });
