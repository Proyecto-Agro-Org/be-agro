import type { ClientSession } from 'mongoose';

export interface BusinessScope { readonly realm: string; readonly clientId: string }
export interface BusinessRecord {
  readonly id: string; readonly clientId: string; readonly name: string; readonly description: string | null;
  readonly active: boolean; readonly createdAt: number; readonly updatedAt: number; readonly version: number;
}
export interface AreaRecord extends BusinessRecord { readonly fieldId: string }
export interface PageInput { readonly after?: string; readonly limit: number }
export interface Page<T> { readonly rows: readonly T[]; readonly next: string | null }
export interface CreateBusinessInput { readonly name: string; readonly description: string | null }
export interface PatchBusinessInput { readonly name?: string; readonly description?: string | null; readonly version: number }
export interface BusinessRepository {
  listFields(scope: BusinessScope, page: PageInput): Promise<Page<BusinessRecord>>;
  getField(scope: BusinessScope, id: string): Promise<BusinessRecord>;
  createField(scope: BusinessScope, input: CreateBusinessInput): Promise<BusinessRecord>;
  patchField(scope: BusinessScope, id: string, input: PatchBusinessInput): Promise<BusinessRecord>;
  deactivateField(scope: BusinessScope, id: string, version: number): Promise<void>;
  listAreas(scope: BusinessScope, fieldId: string, page: PageInput): Promise<Page<AreaRecord>>;
  getArea(scope: BusinessScope, fieldId: string, id: string): Promise<AreaRecord>;
  createArea(scope: BusinessScope, fieldId: string, input: CreateBusinessInput): Promise<AreaRecord>;
  patchArea(scope: BusinessScope, fieldId: string, id: string, input: PatchBusinessInput): Promise<AreaRecord>;
  deactivateArea(scope: BusinessScope, fieldId: string, id: string, version: number): Promise<void>;
}
// Internal trusted integration port, never provided by an HTTP request. Unknown blocks deletion.
// A future sensor writer MUST join the same transaction/client control protocol.
export interface AreaDependencies {
  inspectField?(scope: BusinessScope, fieldId: string, session: ClientSession): Promise<'clear' | 'blocked' | 'unknown'>;
  inspect(scope: BusinessScope, fieldId: string, areaId: string, session: ClientSession): Promise<'clear' | 'blocked' | 'unknown'>;
}
