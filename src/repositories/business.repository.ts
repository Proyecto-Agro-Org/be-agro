import { randomUUID } from 'node:crypto';
import type { Connection, ClientSession } from 'mongoose';
import { z } from 'zod';
import { logicalKey } from '../auth/validation.js';
import { catalogueRealmSchema } from '../auth/identity-catalogue.schemas.js';
import { ApplicationError } from '../errors/application.error.js';
import { businessCollections, defineBusinessModels, type BusinessDocument } from '../models/business.models.js';
import type { AreaDependencies, AreaRecord, BusinessRecord, BusinessRepository, BusinessScope, CreateBusinessInput, PageInput, PatchBusinessInput } from '../business/contracts.js';
import { businessRecordSchema, areaRecordSchema, versionSchema } from '../business/schemas.js';
const scopeSchema = z.object({ realm: catalogueRealmSchema, clientId: logicalKey }).strict();
const pageInput = z.object({ after: logicalKey.optional(), limit: z.number().int().min(1).max(100) }).strict();
function fail(code: 'RESOURCE_NOT_FOUND' | 'CONFLICT' | 'DEPENDENCY_UNAVAILABLE'): never { throw new ApplicationError(code); }
function key(id: string) { if (!logicalKey.safeParse(id).success) throw new ApplicationError('VALIDATION_ERROR'); return id; }
function map(row: BusinessDocument): BusinessRecord {
  const result = businessRecordSchema.safeParse({ id: row.id, clientId: row.clientId, name: row.name, description: row.description,
    active: row.active, version: row.version, createdAt: row.createdAt?.getTime(), updatedAt: row.updatedAt?.getTime() });
  if (!result.success) fail('DEPENDENCY_UNAVAILABLE'); return result.data;
}
function mapArea(row: BusinessDocument): AreaRecord {
  const result = areaRecordSchema.safeParse({ ...map(row), fieldId: row.fieldId });
  if (!result.success) fail('DEPENDENCY_UNAVAILABLE'); return result.data;
}
export async function createMongooseBusinessRepository(options: { connection: Connection; prefix: string; dependencies?: AreaDependencies;
  now?: () => number }): Promise<BusinessRepository> {
  const { connection, prefix } = options, n = businessCollections(prefix), models = defineBusinessModels(connection, prefix);
  const db = connection.db; if (!db || !(await db.command({ hello: 1 })).setName) fail('DEPENDENCY_UNAVAILABLE');
  const fields = db.collection<BusinessDocument>(n.fields), areas = db.collection<BusinessDocument>(n.areas);
  const controls = db.collection<{ _id: string; realm: string; clientId: string; version: number }>(n.controls);
  async function verify() {
    for (const [name, expected] of [[n.fields, { realm: 1, id: 1 }], [n.areas, { realm: 1, id: 1 }], [n.controls, { realm: 1, clientId: 1 }]] as const) {
      const indexes = await db!.collection(name).listIndexes({ maxTimeMS: 3000 }).toArray();
      if (!indexes.some(i => JSON.stringify(i.key) === JSON.stringify(expected) && i.unique === true && !i.sparse && !i.partialFilterExpression &&
        i.expireAfterSeconds === undefined && (!i.collation || i.collation.locale === 'simple'))) fail('DEPENDENCY_UNAVAILABLE');
    }
  }
  try { await verify(); } catch { fail('DEPENDENCY_UNAVAILABLE'); }
  function scope(s: BusinessScope) { const r = scopeSchema.safeParse(s); if (!r.success) throw new ApplicationError('FORBIDDEN'); return r.data; }
  async function guarded<T>(operation: () => Promise<T>): Promise<T> {
    try { await verify(); return await operation(); }
    catch (e) { if (e instanceof ApplicationError) throw e;
      if (typeof e === 'object' && e !== null && 'code' in e && e.code === 11000) fail('CONFLICT'); fail('DEPENDENCY_UNAVAILABLE'); }
  }
  async function transaction<T>(s: BusinessScope, operation: (session: ClientSession, at: Date) => Promise<T>): Promise<T> {
    return guarded(async () => {
      const at = new Date((options.now ?? Date.now)()); if (!Number.isFinite(at.getTime()) || at.getTime() < 0) fail('DEPENDENCY_UNAVAILABLE');
      // Materialize only the coordination row outside the transaction. All business writes
      // serialize on the row below; the row itself contains no public business resource.
      if (!(await controls.updateOne({ _id: s.realm + ':' + s.clientId }, { $setOnInsert: { ...s, version: 0 } }, { upsert: true })).acknowledged) fail('DEPENDENCY_UNAVAILABLE');
      const session = await connection.startSession();
      try { return await session.withTransaction(async () => {
        const result = await controls.updateOne({ _id: s.realm + ':' + s.clientId, ...s, version: { $lt: Number.MAX_SAFE_INTEGER - 1 } },
          { $inc: { version: 1 } }, { session });
        if (!result.acknowledged || result.matchedCount !== 1) fail('DEPENDENCY_UNAVAILABLE');
        return operation(session, at);
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority', j: true, wtimeoutMS: 3000 }, maxCommitTimeMS: 3000, timeoutMS: 10000 }); }
      finally { await session.endSession(); }
    });
  }
  async function field(s: BusinessScope, id: string, session?: ClientSession) {
    const row = await fields.findOne({ ...s, id: key(id), active: true }, { session, maxTimeMS: 3000 });
    if (!row) fail('RESOURCE_NOT_FOUND'); return row;
  }
  async function area(s: BusinessScope, fieldId: string, id: string, session?: ClientSession) {
    await field(s, fieldId, session);
    const row = await areas.findOne({ ...s, fieldId, id: key(id), active: true }, { session, maxTimeMS: 3000 });
    if (!row) fail('RESOURCE_NOT_FOUND'); return row;
  }
  function content(input: CreateBusinessInput | PatchBusinessInput) {
    // Validate again at the persistence boundary; update operators cannot enter via a port.
    const result = z.object({ name: z.string().trim().min(1).max(120).refine(v => !/[\p{Cc}\p{Cf}]/u.test(v)), description: z.string().max(2000).nullable() }).partial().strict()
      .safeParse(Object.fromEntries(Object.entries(input).filter(([k, v]) => k !== 'version' && v !== undefined)));
    if (!result.success || Object.keys(result.data).length === 0) throw new ApplicationError('VALIDATION_ERROR');
    return result.data;
  }
  function revision(version: number) { if (!versionSchema.safeParse(version).success) throw new ApplicationError('VALIDATION_ERROR'); if (version >= Number.MAX_SAFE_INTEGER - 1) fail('CONFLICT'); return version; }
  function chronology(at: Date, before: BusinessDocument) { if (at < before.updatedAt || at < before.createdAt) fail('DEPENDENCY_UNAVAILABLE'); }
  function page<T>(rows: T[], limit: number, id: (r: T) => string) { return { rows: rows.slice(0, limit), next: rows.length > limit ? id(rows[limit - 1]) : null }; }
  return {
    listFields: (s, p) => guarded(async () => { const q = pageInput.parse(p); const rows = await fields.find({ ...scope(s), active: true,
      ...(q.after ? { id: { $gt: q.after } } : {}) }).sort({ id: 1 }).limit(q.limit + 1).maxTimeMS(3000).toArray(); return page(rows.map(map), q.limit, r => r.id); }),
    getField: (s, id) => guarded(async () => map(await field(scope(s), id))),
    createField: (s, input) => { s = scope(s); return transaction(s, async (session, at) => {
      const data = content(input); if (!data.name) throw new ApplicationError('VALIDATION_ERROR');
      const id = randomUUID(), row = { _id: s.realm + ':' + id, ...s, id, name: data.name, description: data.description ?? null, active: true, version: 0, createdAt: at, updatedAt: at };
      if (!(await fields.insertOne(row, { session })).acknowledged) fail('DEPENDENCY_UNAVAILABLE'); return map(row);
    }); },
    patchField: (s, id, input) => { s = scope(s); return transaction(s, async (session, at) => {
      const before = await field(s, id, session), v = revision(input.version); if (before.version !== v) fail('CONFLICT');
      chronology(at, before);
      const row = { ...before, ...content(input), version: v + 1, updatedAt: at };
      const result = await fields.replaceOne({ ...s, id, version: v, active: true }, row, { session });
      if (!result.acknowledged) fail('DEPENDENCY_UNAVAILABLE'); if (result.matchedCount !== 1 || result.modifiedCount !== 1) fail('CONFLICT'); return map(row);
    }); },
    deactivateField: (s, id, version) => { s = scope(s); return transaction(s, async (session, at) => {
      const row = await field(s, id, session); if (row.version !== revision(version)) fail('CONFLICT');
      chronology(at, row);
      if (await areas.findOne({ ...s, fieldId: id }, { session, projection: { _id: 1 }, maxTimeMS: 3000 })) fail('CONFLICT');
      const state = await options.dependencies?.inspectField?.(s, id, session) ?? 'unknown';
      if (state === 'blocked') fail('CONFLICT'); if (state !== 'clear') fail('DEPENDENCY_UNAVAILABLE');
      const result = await fields.updateOne({ ...s, id, version }, { $set: { active: false, updatedAt: at }, $inc: { version: 1 } }, { session });
      if (!result.acknowledged) fail('DEPENDENCY_UNAVAILABLE'); if (result.matchedCount !== 1 || result.modifiedCount !== 1) fail('CONFLICT');
    }); },
    listAreas: (s, fieldId, p) => guarded(async () => { s = scope(s); await field(s, fieldId); const q = pageInput.parse(p);
      const rows = await areas.find({ ...s, fieldId, active: true, ...(q.after ? { id: { $gt: q.after } } : {}) }).sort({ id: 1 }).limit(q.limit + 1).maxTimeMS(3000).toArray();
      return page(rows.map(mapArea), q.limit, r => r.id); }),
    getArea: (s, fieldId, id) => guarded(async () => mapArea(await area(scope(s), fieldId, id))),
    createArea: (s, fieldId, input) => { s = scope(s); return transaction(s, async (session, at) => {
      await field(s, fieldId, session); const data = content(input); if (!data.name) throw new ApplicationError('VALIDATION_ERROR');
      const id = randomUUID(), row = { _id: s.realm + ':' + id, ...s, fieldId, id, name: data.name, description: data.description ?? null, active: true, version: 0, createdAt: at, updatedAt: at };
      if (!(await areas.insertOne(row, { session })).acknowledged) fail('DEPENDENCY_UNAVAILABLE'); return mapArea(row);
    }); },
    patchArea: (s, fieldId, id, input) => { s = scope(s); return transaction(s, async (session, at) => {
      const before = await area(s, fieldId, id, session), v = revision(input.version); if (before.version !== v) fail('CONFLICT');
      chronology(at, before);
      const row = { ...before, ...content(input), version: v + 1, updatedAt: at };
      const result = await areas.replaceOne({ ...s, fieldId, id, version: v, active: true }, row, { session });
      if (!result.acknowledged) fail('DEPENDENCY_UNAVAILABLE'); if (result.matchedCount !== 1 || result.modifiedCount !== 1) fail('CONFLICT'); return mapArea(row);
    }); },
    deactivateArea: (s, fieldId, id, version) => { s = scope(s); return transaction(s, async (session, at) => {
      const row = await area(s, fieldId, id, session); if (row.version !== revision(version)) fail('CONFLICT');
      chronology(at, row);
      const state = await options.dependencies?.inspect(s, fieldId, id, session) ?? 'unknown';
      if (state === 'blocked') fail('CONFLICT'); if (state !== 'clear') fail('DEPENDENCY_UNAVAILABLE');
      const result = await areas.updateOne({ ...s, fieldId, id, version, active: true }, { $set: { active: false, updatedAt: at }, $inc: { version: 1 } }, { session });
      if (!result.acknowledged) fail('DEPENDENCY_UNAVAILABLE'); if (result.matchedCount !== 1 || result.modifiedCount !== 1) fail('CONFLICT');
    }); },
  };
}
