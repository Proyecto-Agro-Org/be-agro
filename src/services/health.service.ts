// Process liveness only: no persistence, external services or readiness checks.
export function getHealthStatus(): { status: 'ok' } {
  return { status: 'ok' };
}
