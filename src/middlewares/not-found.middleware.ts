import type { RequestHandler } from 'express';
import { ApplicationError } from '../errors/application.error.js';

// Preserve HTML and status, but never reflect a client-controlled pathname.
export const legacyNotFound: RequestHandler = (_request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  response.status(404).type('html').send('<!DOCTYPE html><html><head><title>Not found</title></head><body><p>Not found</p></body></html>');
};

export const safeNotFound: RequestHandler = (_request, _response, next) => {
  next(new ApplicationError('RESOURCE_NOT_FOUND'));
};
