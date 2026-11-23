import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isApplicationErrorCode } from '../src/errors/application.error.js';

export interface Be11FailureEvidence {
  readonly stage: string;
  readonly category: string;
  readonly errorClass: string;
}

function safeLabel(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^[A-Za-z0-9_. -]{1,120}$/.test(value) ? value : fallback;
}

export function classifyBe11Failure(stage: string, error: unknown): Be11FailureEvidence {
  let category = 'unexpected-error';
  let errorClass = 'UnknownError';
  if (typeof error === 'object' && error !== null) {
    try {
      if ('name' in error) errorClass = safeLabel(error.name, 'UnknownError');
      if ('code' in error) {
        const code = error.code;
        if (isApplicationErrorCode(code)) category = code;
        else if (code === 11000) category = 'mongo-duplicate-key';
        else if (code === 121) category = 'mongo-document-validation';
        else if (code === 'ERR_ASSERTION') category = 'assertion-failed';
      }
    } catch {
      return Object.freeze({ stage: safeLabel(stage, 'unknown-stage'), category: 'unreadable-error', errorClass: 'UnknownError' });
    }
  }
  return Object.freeze({ stage: safeLabel(stage, 'unknown-stage'), category, errorClass });
}

export function writeBe11Evidence(directory: string, filename: string, value: unknown): string {
  const safeFilename = /^[a-z0-9][a-z0-9.-]{0,80}\.json$/.test(filename) ? filename : 'be11-invalid-filename.json';
  const evidenceDirectory = join(directory, '.local-evidence');
  mkdirSync(evidenceDirectory, { recursive: true });
  const path = join(evidenceDirectory, safeFilename);
  writeFileSync(path, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'w' });
  return path;
}
