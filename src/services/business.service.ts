import type { AuthorizationContext } from '../auth/contracts.js';
import type { IdentityCatalogueStore } from '../auth/identity-catalogue.contracts.js';
import { catalogueClientRecordSchema, catalogueRealmSchema } from '../auth/identity-catalogue.schemas.js';
import { checkedOutput, logicalKey } from '../auth/validation.js';
import type { BusinessRepository, BusinessScope } from '../business/contracts.js';
import { areaRecordSchema, businessRecordSchema } from '../business/schemas.js';
import type { AuthorizationService } from './authorization.service.js';
import { ApplicationError } from '../errors/application.error.js';
export function createBusinessService(options: { authorization: AuthorizationService; catalogue: IdentityCatalogueStore;
  repository: BusinessRepository; realm: string }) {
  const realm = catalogueRealmSchema.parse(options.realm), { authorization, catalogue, repository } = options;
  async function scope(context: AuthorizationContext) {
    authorization.assertContext(context);
    let raw;
    try { raw = await catalogue.findClientById({ realm, clientId: context.clientId }); }
    catch { throw new ApplicationError('DEPENDENCY_UNAVAILABLE'); }
    authorization.assertContext(context);
    const client = checkedOutput(catalogueClientRecordSchema.nullable(), raw);
    if (!client || client.id !== context.clientId || !client.active) throw new ApplicationError('FORBIDDEN');
    return { query: Object.freeze({ realm, clientId: client.id }), client };
  }
  const key = (value: unknown) => { const r = logicalKey.safeParse(value); if (!r.success) throw new ApplicationError('VALIDATION_ERROR'); return r.data; };
  async function execute<T>(context: AuthorizationContext, operation: (s: BusinessScope) => Promise<T>): Promise<T> {
    const { query } = await scope(context);
    try { const result = await operation(query); authorization.assertContext(context); return result; }
    catch (e) { if (e instanceof ApplicationError) throw e; throw new ApplicationError('DEPENDENCY_UNAVAILABLE'); }
  }
  function field(s: BusinessScope, raw: unknown) {
    const row = checkedOutput(businessRecordSchema, raw);
    if (row.clientId !== s.clientId) throw new ApplicationError('RESOURCE_NOT_FOUND');
    return row;
  }
  function area(s: BusinessScope, fieldId: string, raw: unknown) {
    const row = checkedOutput(areaRecordSchema, raw);
    if (row.clientId !== s.clientId || row.fieldId !== fieldId) throw new ApplicationError('RESOURCE_NOT_FOUND');
    return row;
  }
  return Object.freeze({ authorization,
    async current(context: AuthorizationContext) { const { client } = await scope(context); return {
      cliente_id: client.id, nombre: client.name, activo: client.active, campos_url: '/api/v1/campos' }; },
    listFields: (c: AuthorizationContext, page: import('../business/contracts.js').PageInput) => execute(c, async s => {
      const p = await repository.listFields(s, page); return { rows: p.rows.map(r => field(s, r)), next: p.next }; }),
    getField: (c: AuthorizationContext, id: string) => execute(c, async s => { const row = field(s, await repository.getField(s, key(id))); if (row.id !== id) throw new ApplicationError('RESOURCE_NOT_FOUND'); return row; }),
    createField: (c: AuthorizationContext, input: import('../business/contracts.js').CreateBusinessInput) => execute(c, async s => field(s, await repository.createField(s, input))),
    patchField: (c: AuthorizationContext, id: string, input: import('../business/contracts.js').PatchBusinessInput) => execute(c, async s => field(s, await repository.patchField(s, key(id), input))),
    deactivateField: (c: AuthorizationContext, id: string, version: number) => execute(c, s => repository.deactivateField(s, key(id), version)),
    listAreas: (c: AuthorizationContext, fieldId: string, page: import('../business/contracts.js').PageInput) => execute(c, async s => {
      const p = await repository.listAreas(s, key(fieldId), page); return { rows: p.rows.map(r => area(s, fieldId, r)), next: p.next }; }),
    getArea: (c: AuthorizationContext, fieldId: string, id: string) => execute(c, async s => { const row = area(s, fieldId, await repository.getArea(s, key(fieldId), key(id))); if (row.id !== id) throw new ApplicationError('RESOURCE_NOT_FOUND'); return row; }),
    createArea: (c: AuthorizationContext, fieldId: string, input: import('../business/contracts.js').CreateBusinessInput) => execute(c, async s => area(s, fieldId, await repository.createArea(s, key(fieldId), input))),
    patchArea: (c: AuthorizationContext, fieldId: string, id: string, input: import('../business/contracts.js').PatchBusinessInput) => execute(c, async s => area(s, fieldId, await repository.patchArea(s, key(fieldId), key(id), input))),
    deactivateArea: (c: AuthorizationContext, fieldId: string, id: string, version: number) => execute(c, s => repository.deactivateArea(s, key(fieldId), key(id), version)),
  });
}
export type BusinessService = ReturnType<typeof createBusinessService>;
