import { z } from 'zod';
import { logicalKey, epoch } from '../auth/validation.js';
export const versionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1);
const name = z.string().trim().min(1).max(120).refine(v => !/[\p{Cc}\p{Cf}]/u.test(v));
const description = z.string().max(2000).nullable();
export const createBusinessSchema = z.object({ nombre: name, descripcion: description.optional() }).strict();
export const patchBusinessSchema = z.object({ nombre: name.optional(), descripcion: description.optional(), version: versionSchema }).strict()
  .refine(v => v.nombre !== undefined || v.descripcion !== undefined);
const integerQuery = z.string().regex(/^(0|[1-9][0-9]{0,15})$/).transform(Number);
export const pageSchema = z.object({ after: logicalKey.optional(), limit: integerQuery.pipe(z.number().int().min(1).max(100)).optional().default(50) }).strict();
export const deleteSchema = z.object({ version: integerQuery.pipe(versionSchema) }).strict();
export const fieldParams = z.object({ campoId: logicalKey }).strict();
export const areaParams = z.object({ areaId: logicalKey }).strict();
export const areaQuery = pageSchema.extend({ campo_id: logicalKey }).strict();
export const areaItemQuery = z.object({ campo_id: logicalKey }).strict();
export const areaDeleteQuery = deleteSchema.extend({ campo_id: logicalKey }).strict();
export const emptySchema = z.object({}).strict();
export const businessRecordSchema = z.object({ id: logicalKey, clientId: logicalKey, name, description,
  active: z.boolean(), createdAt: epoch, updatedAt: epoch, version: versionSchema }).strict()
  .refine(v => v.updatedAt >= v.createdAt);
export const areaRecordSchema = businessRecordSchema.safeExtend({ fieldId: logicalKey });
