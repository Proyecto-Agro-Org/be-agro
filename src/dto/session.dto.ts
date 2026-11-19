import { z } from 'zod';
import type { SessionView } from '../auth/session.contracts.js';
import { isOpaqueSecret } from '../auth/session-security.js';
import { ApplicationError } from '../errors/application.error.js';

export const emptySessionInput = z.object({}).strict();
export const createChallengeRequestSchema = emptySessionInput;
export const googleLoginRequestSchema = z.object({ provider: z.literal('google'),
  credential: z.string().min(1).max(8192), challenge_id: z.string().refine(isOpaqueSecret),
}).strict();
export type CreateChallengeRequest = z.output<typeof createChallengeRequestSchema>;
export interface CreateChallengeResponse { challenge_id: string; nonce: string; expires_at: string }
export type GoogleLoginRequest = z.output<typeof googleLoginRequestSchema>;
// GetSessionRequest/LogoutRequest have no params/query/body; Bearer is transport.
export interface GetSessionResponse {
  usuario: { usuario_id: string; nombre: string; email: string; cliente_id: string };
  cliente: { cliente_id: string; nombre: string };
  sesion: { expira_en: string; expira_por_inactividad_en: string };
}
export interface GoogleLoginResponse extends GetSessionResponse { token: string; token_type: 'Bearer' }
export type LogoutResponse = void;
export function toSessionResponse(value: SessionView): GetSessionResponse {
  const { user } = value;
  if (!user.client) throw new ApplicationError('FORBIDDEN');
  return { usuario: { usuario_id: user.id, nombre: user.name, email: user.email, cliente_id: user.client.id },
    cliente: { cliente_id: user.client.id, nombre: user.client.name },
    sesion: { expira_en: new Date(value.absoluteExpiresAt).toISOString(), expira_por_inactividad_en: new Date(value.idleExpiresAt).toISOString() } };
}
