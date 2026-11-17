import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Request, RequestHandler, Response } from 'express';
import { isApplicationErrorCode, type ApplicationErrorCode } from '../errors/application.error.js';

export interface RequestLog {
  readonly timestamp: string;
  readonly event: 'request.start' | 'request.finish' | 'request.error';
  readonly requestId: string;
  readonly method: string;
  readonly route: string;
  readonly status?: number;
  readonly durationMs?: number;
  readonly errorCode?: ApplicationErrorCode;
  readonly outcome?: 'finished' | 'aborted';
}
export type LogSink = (record: Readonly<RequestLog>) => void | Promise<void>;

export function createRequestObservability(
  sink: LogSink = record => console.info(JSON.stringify(record)),
) {
  const contexts = new WeakMap<Request, { id: string; route: string; started: number; registered: boolean }>();
  const methods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

  function emit(record: RequestLog) {
    try {
      // A logging failure must not crash finish handlers or expose its payload.
      void Promise.resolve(sink(Object.freeze(record))).catch(() => {});
    } catch { /* Best effort; never log the logger's raw exception. */ }
  }

  function context(request: Request, response: Response) {
    let value = contexts.get(request);
    if (!value) {
      // Ignore incoming IDs and forwarded headers, including from proxies.
      value = { id: randomUUID(), route: 'unmatched', started: performance.now(), registered: false };
      contexts.set(request, value);
      if (!response.headersSent) response.setHeader('X-Request-ID', value.id);
    }
    return value;
  }

  function record(request: Request, response: Response, event: RequestLog['event']): RequestLog {
    const value = context(request, response);
    return { timestamp: new Date().toISOString(), event, requestId: value.id,
      method: methods.has(request.method) ? request.method : 'OTHER', route: value.route };
  }

  const contextMiddleware: RequestHandler = (request, response, next) => {
    context(request, response);
    next();
  };

  const middleware: RequestHandler = (request, response, next) => {
    const value = context(request, response);
    if (!value.registered) {
      value.registered = true;
      emit(record(request, response, 'request.start'));
      let completed = false;
      const finish = () => {
        if (completed) return;
        completed = true;
        response.removeListener('finish', finish);
        response.removeListener('close', finish);
        const status = response.statusCode;
        emit({ ...record(request, response, 'request.finish'), status:
          typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : 500,
          durationMs: Math.max(0, Math.round((performance.now() - value.started) * 1000) / 1000),
          outcome: response.writableFinished ? 'finished' : 'aborted' });
      };
      response.once('finish', finish);
      response.once('close', finish);
    }
    next();
  };

  function routeLabel(label: string): RequestHandler {
    if (typeof label !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(label)) {
      throw new TypeError('Etiqueta de ruta no válida.');
    }
    return (request, response, next) => { context(request, response).route = label; next(); };
  }

  function logError(request: Request, response: Response, status: number, errorCode: ApplicationErrorCode) {
    emit({ ...record(request, response, 'request.error'),
      status: typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500,
      errorCode: isApplicationErrorCode(errorCode) ? errorCode : 'INTERNAL_ERROR' });
  }

  return { middleware, contextMiddleware, routeLabel, logError,
    getRequestId: (request: Request, response: Response) => context(request, response).id };
}
