import type { AreaRecord, BusinessRecord, Page } from '../business/contracts.js';
import type { z } from 'zod';
import type { createBusinessSchema, patchBusinessSchema, pageSchema, deleteSchema, areaQuery } from '../business/schemas.js';
import type { ErrorResponseAdapter } from '../http/error-response.js';
export const businessErrorResponse: ErrorResponseAdapter = error => ({ error: { code: error.code, message: error.message } });
export type CreateCampoRequest = z.output<typeof createBusinessSchema>;
export type UpdateCampoRequest = z.output<typeof patchBusinessSchema>;
export type ListCamposRequest = z.output<typeof pageSchema>;
export type DeleteCampoRequest = z.output<typeof deleteSchema>;
export type CreateAreaRequest = CreateCampoRequest;
export type UpdateAreaRequest = UpdateCampoRequest;
export type ListAreasRequest = z.output<typeof areaQuery>;
export interface GetCampoRequest { campoId: string }
export interface GetAreaRequest { areaId: string; campo_id: string }
export interface DeleteAreaRequest extends GetAreaRequest { version: number }
export interface CampoResponse { campo_id: string; cliente_id: string; nombre: string; descripcion: string | null;
  activo: boolean; created_at: string; updated_at: string; version: number }
export interface AreaResponse extends Omit<CampoResponse, 'campo_id' | 'cliente_id'> { area_id: string; campo_id: string }
export interface CurrentClienteResponse { cliente_id: string; nombre: string; activo: boolean; campos_url: string }
// Current client has no request body, params or query. DELETE responses have no body.
export type GetCurrentClienteRequest = Record<string, never>;
export type GetCurrentClienteResponse = CurrentClienteResponse;
export type GetCampoResponse = CampoResponse;
export type CreateCampoResponse = CampoResponse;
export type UpdateCampoResponse = CampoResponse;
export type DeleteCampoResponse = void;
export type GetAreaResponse = AreaResponse;
export type CreateAreaResponse = AreaResponse;
export type UpdateAreaResponse = AreaResponse;
export type DeleteAreaResponse = void;
export interface ListCamposResponse { campos: CampoResponse[]; next: string | null }
export interface ListAreasResponse { areas: AreaResponse[]; next: string | null }
export function campoResponse(row: BusinessRecord): CampoResponse {
  return { campo_id: row.id, cliente_id: row.clientId, nombre: row.name, descripcion: row.description, activo: row.active,
    created_at: new Date(row.createdAt).toISOString(), updated_at: new Date(row.updatedAt).toISOString(), version: row.version };
}
export function areaResponse(row: AreaRecord): AreaResponse {
  const { cliente_id: _client, campo_id: _id, ...common } = campoResponse(row);
  return { ...common, area_id: row.id, campo_id: row.fieldId };
}
export const camposResponse = (page: Page<BusinessRecord>): ListCamposResponse => ({ campos: page.rows.map(campoResponse), next: page.next });
export const areasResponse = (page: Page<AreaRecord>): ListAreasResponse => ({ areas: page.rows.map(areaResponse), next: page.next });
