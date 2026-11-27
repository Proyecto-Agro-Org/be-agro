// BE14-04 — verdict labelling for EXTERNAL observed runs. Pure and separately testable: a test double / harness bridge can NEVER earn `CONFORMANCE PASS EXTERNAL`.
export interface ExternalIdentity { /** what the operator declares in the config */ declaredKind: 'real-external' | 'test-bridge' | 'undeclared'; name?: string; /** set when the bridge (or the config) marks itself as a test double */ testDouble: boolean }
export interface VerdictInput { totals: { fail: number; notRun: number; skip: number; pass: number }; results: { testId: string; status: string }[]; requiredTests: string[]; identity: ExternalIdentity; infrastructureFailed?: boolean }
/** BE14-05: every non-optional test is required for `PASS EXTERNAL`, INCLUDING those that SKIP with DECISION_PENDING when the firmware lacks the capacity/policy test hooks: a MUST (no silent drop on saturation, explicit exhaustion) must never go unverified. */
export const requiredTestIds = (catalog: readonly { id: string; optional?: boolean; skipWhenMissing?: string }[]): string[] => catalog.filter(t => !t.optional).map(t => t.id);

export function externalVerdict(i: VerdictInput): { verdict: string; label: 'HARNESS_SELF_TEST' | 'EXTERNAL' | 'NONE' } {
  if (i.infrastructureFailed) return { verdict: 'CONFORMANCE INFRA_ERROR', label: 'NONE' };
  if (i.totals.fail > 0) return { verdict: 'CONFORMANCE FAIL', label: i.identity.testDouble ? 'HARNESS_SELF_TEST' : 'NONE' };
  const status = new Map(i.results.map(r => [r.testId, r.status])); const allRequiredPass = i.requiredTests.every(id => status.get(id) === 'PASS');
  if (i.totals.notRun > 0 || !allRequiredPass) return { verdict: 'CONFORMANCE INCOMPLETE', label: i.identity.testDouble ? 'HARNESS_SELF_TEST' : 'NONE' };
  if (i.identity.testDouble || i.identity.declaredKind !== 'real-external') return { verdict: 'HARNESS_SELF_TEST PASS (external observed; a test double is not a publisher certification)', label: 'HARNESS_SELF_TEST' };
  return { verdict: 'CONFORMANCE PASS EXTERNAL', label: 'EXTERNAL' };
}
