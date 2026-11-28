import type { Request, RequestHandler, Response } from 'express';
import type { AuthenticatedIdentity, AuthorizationContext, AuthenticationState } from '../auth/contracts.js';
import type { AuthorizationService } from '../services/authorization.service.js';
import { ApplicationError } from '../errors/application.error.js';

interface RequestState {
  readonly response: Response;
  identity?: AuthenticatedIdentity;
  context?: AuthorizationContext;
  authorization?: symbol;
}

export function createRequestAuthorization(service: AuthorizationService) {
  const states = new WeakMap<Request, RequestState>();
  const observed = new WeakSet<Request>();
  const closed = new WeakSet<Request>();
  function clear(request: Request) {
    const previous = states.get(request);
    if (previous?.identity) service.invalidate(previous.identity);
    states.delete(request);
  }
  function getAuthenticatedIdentity(request: Request): AuthenticatedIdentity {
    const state = states.get(request);
    const identity = state?.identity;
    if (!identity || closed.has(request) || state.response.writableEnded || state.response.destroyed) {
      clear(request);
      throw new ApplicationError('UNAUTHENTICATED');
    }
    service.assertIdentity(identity);
    return identity;
  }
  function getAuthorizationContext(request: Request): AuthorizationContext {
    getAuthenticatedIdentity(request);
    const context = states.get(request)?.context;
    if (!context) throw new ApplicationError('FORBIDDEN');
    service.assertContext(context);
    return context;
  }
  const authenticate: RequestHandler = async (request, response, next) => {
    clear(request);
    if (closed.has(request) || response.writableEnded || response.destroyed) {
      next(new ApplicationError('UNAUTHENTICATED')); return;
    }
    if (!observed.has(request)) {
      observed.add(request);
      const cleanup = () => {
        closed.add(request); clear(request);
        response.removeListener('finish', cleanup); response.removeListener('close', cleanup);
      };
      response.once('finish', cleanup); response.once('close', cleanup);
    }
    const state: RequestState = { response };
    states.set(request, state);
    let issued: AuthenticatedIdentity | undefined;
    try {
      const rawHeaders = request.rawHeaders ?? [];
      let count = 0;
      for (let i = 0; i < rawHeaders.length; i += 2) if (rawHeaders[i].toLowerCase() === 'authorization') count++;
      const header = request.headers.authorization;
      if (count > 1 || typeof header !== 'string' || !/^Bearer /i.test(header)) throw new ApplicationError('UNAUTHENTICATED');
      issued = await service.authenticate(header.slice(7));
      if (closed.has(request) || response.writableEnded || response.destroyed || states.get(request) !== state) {
        service.invalidate(issued); throw new ApplicationError('UNAUTHENTICATED');
      }
      state.identity = issued;
      service.bindToRequest(issued, () => !closed.has(request) && states.get(request) === state &&
        !response.writableEnded && !response.destroyed);
    } catch (error: unknown) {
      if (issued) service.invalidate(issued);
      if (states.get(request) === state) clear(request);
      next(error instanceof ApplicationError ? error : new ApplicationError('INTERNAL_ERROR'));
      return;
    }
    next();
  };
  const requireClient: RequestHandler = async (request, _response, next) => {
    const state = states.get(request);
    const execution = Symbol();
    try {
      const identity = getAuthenticatedIdentity(request);
      if (!state) throw new ApplicationError('UNAUTHENTICATED');
      state.context = undefined; state.authorization = execution;
      const context = await service.authorize(identity);
      if (closed.has(request) || state.response.writableEnded || state.response.destroyed) {
        if (states.get(request) === state) clear(request);
        throw new ApplicationError('UNAUTHENTICATED');
      }
      if (states.get(request) !== state || state.authorization !== execution) {
        throw new ApplicationError('UNAUTHENTICATED');
      }
      state.context = context;
    } catch (error: unknown) {
      if (state && states.get(request) === state && state.authorization === execution) state.context = undefined;
      next(error instanceof ApplicationError ? error : new ApplicationError('INTERNAL_ERROR'));
      return;
    }
    next();
  };
  function getState(request: Request): AuthenticationState {
    try { getAuthorizationContext(request); return 'authorized'; }
    catch { try { getAuthenticatedIdentity(request); return 'authenticated'; } catch { return 'unauthenticated'; } }
  }
  return Object.freeze({ authenticate, requireClient, getAuthenticatedIdentity, getAuthorizationContext, getState });
}
