import type { RequestHandler } from 'express';
import { z } from 'zod';
import { readSessionBearer } from '../auth/bearer.js';
import { createChallengeRequestSchema, emptySessionInput, googleLoginRequestSchema, toSessionResponse,
  type CreateChallengeResponse, type GoogleLoginResponse } from '../dto/session.dto.js';
import { createRequestValidation } from '../middlewares/validate-request.middleware.js';
import type { createRequestAuthorization } from '../middlewares/request-authorization.middleware.js';
import type { SessionService } from '../services/session.service.js';

export function createSessionControllers(service: SessionService, authorization: ReturnType<typeof createRequestAuthorization>) {
  const challengeInput = createRequestValidation({ body: createChallengeRequestSchema, query: emptySessionInput, params: emptySessionInput });
  const loginInput = createRequestValidation({ body: googleLoginRequestSchema, query: emptySessionInput, params: emptySessionInput });
  const noInput = createRequestValidation({ body: z.undefined(), query: emptySessionInput, params: emptySessionInput });
  const challenge: RequestHandler = async (request, response) => {
    challengeInput.getValidatedData(request);
    const value = await service.challenge();
    const dto: CreateChallengeResponse = { challenge_id: value.challengeId, nonce: value.nonce, expires_at: new Date(value.expiresAt).toISOString() };
    if (!response.writableEnded && !response.destroyed && !response.headersSent) response.status(200).json(dto);
  };
  const login: RequestHandler = async (request, response) => {
    const value = loginInput.getValidatedData(request).body;
    const session = await service.login(value.credential, value.challenge_id);
    const dto: GoogleLoginResponse = { ...toSessionResponse(session), token: session.token, token_type: 'Bearer' };
    if (!response.writableEnded && !response.destroyed && !response.headersSent) response.status(200).json(dto);
  };
  const current: RequestHandler = async (request, response) => {
    noInput.getValidatedData(request);
    const value = await service.current(authorization.getAuthorizationContext(request));
    if (!response.writableEnded && !response.destroyed && !response.headersSent) response.status(200).json(toSessionResponse(value));
  };
  const logout: RequestHandler = async (request, response) => {
    noInput.getValidatedData(request);
    await service.logout(readSessionBearer(request, true));
    if (!response.writableEnded && !response.destroyed && !response.headersSent) response.status(204).end();
  };
  return { challenge, login, current, logout, challengeInput, loginInput, noInput };
}
