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

const dockerFailureCategories: Readonly<Record<string, string>> = Object.freeze({
  DB02_CONTAINER_IDENTITY_MISMATCH: 'container-identity-mismatch',
  DB02_CONTAINER_NOT_RUNNING: 'container-not-running',
  DB02_IMAGE_IDENTITY_MISMATCH: 'image-identity-mismatch',
  DB02_OWNERSHIP_LABEL_MISMATCH: 'ownership-label-mismatch',
  DB02_PRIVILEGED_CONTAINER: 'privileged-container',
  DB02_NETWORK_IDENTITY_MISMATCH: 'network-identity-mismatch',
  DB02_UNEXPECTED_BIND: 'unexpected-bind',
  DB02_UNEXPECTED_MOUNT: 'unexpected-mount',
  DB02_TMPFS_MISMATCH: 'tmpfs-mismatch',
  DB02_LOOPBACK_BINDING_MISMATCH: 'loopback-binding-mismatch',
  DB02_EFFECTIVE_LOOPBACK_BINDING_MISMATCH: 'effective-loopback-binding-mismatch',
  DB02_TOPOLOGY_MISMATCH: 'topology-mismatch',
  DB02_INSPECT_SHAPE_MISMATCH: 'container-inspect-shape-mismatch',
  DB02_NETWORK_INSPECT_SHAPE_MISMATCH: 'network-inspect-shape-mismatch',
  DB02_SHARED_OR_UNKNOWN_NETWORK: 'shared-or-unknown-network',
  DB02_NETWORK_POLICY_MISMATCH: 'network-policy-mismatch',
  DB02_EFFECTIVE_TMPFS_NOT_VERIFIED: 'effective-tmpfs-not-verified',
  DB02_LOCAL_DOCKER_INSPECTION_FAILED: 'local-docker-inspection-failed',
});

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
      if (category === 'unexpected-error' && error instanceof Error)
        category = dockerFailureCategories[error.message] ?? category;
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
