// BE14-03 — CLI:  npm run publisher:conformance [-- --mode reference|external --config <file> --report <file> --levels 0,1 --only L1-01 --integrated <file>]
// Exit codes: 0 PASS · 1 conformance FAIL · 2 invalid configuration · 3 infrastructure unavailable · 4 incomplete (tests NOT_RUN, e.g. external mode)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createStdioBridgeAdapter } from './adapter.js';
import { loadVectors, type Level } from './catalog.js';
import { createReferenceAdapter } from './reference-adapter.js';
import { EXIT, exitCodeFor, humanSummary, runConformance } from './runner.js';
import { validateExternalConfig } from './external-config.js';

const here = dirname(fileURLToPath(import.meta.url));
export function parseCliArgs(argv: readonly string[]) {
  const get = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const mode = get('--mode') ?? 'reference'; if (mode !== 'reference' && mode !== 'external') throw Object.assign(new Error('invalid --mode (reference|external)'), { code: EXIT.INVALID_CONFIG });
  const levels = get('--levels')?.split(',').map(Number); if (levels && levels.some(l => !Number.isInteger(l) || l < 0 || l > 5)) throw Object.assign(new Error('invalid --levels (0..5)'), { code: EXIT.INVALID_CONFIG });
  return { mode: mode as 'reference' | 'external', config: get('--config'), report: get('--report') ?? '.local-evidence/publisher-conformance-report.json', levels: levels as Level[] | undefined, only: get('--only')?.split(','), integrated: get('--integrated'), vectors: get('--vectors') ?? ['test-support/publisher-conformance-vectors.json', resolve(here, '../../../test-support/publisher-conformance-vectors.json')].find(p => existsSync(p)) ?? 'test-support/publisher-conformance-vectors.json' };
}
export async function main(argv: readonly string[], env: Record<string, string | undefined> = process.env, out: (s: string) => void = console.log): Promise<number> {
  let args; try { args = parseCliArgs(argv); } catch (e) { out('INVALID CONFIGURATION: ' + (e as Error).message); return EXIT.INVALID_CONFIG; }
  let vectors; try { vectors = loadVectors(args.vectors); if (vectors.version !== 1 || !vectors.payloads?.length) throw new Error('vectors file invalid'); } catch (e) { out('INVALID CONFIGURATION: cannot load vectors: ' + (e as Error).message); return EXIT.INVALID_CONFIG; }
  let integrated: never[] | undefined; if (args.integrated) { try { integrated = (JSON.parse(readFileSync(args.integrated, 'utf8')) as { results: never[] }).results; if (!Array.isArray(integrated)) throw new Error('no results[]'); } catch (e) { out('INVALID CONFIGURATION: integrated report unreadable: ' + (e as Error).message); return EXIT.INVALID_CONFIG; } }
  let factory: Parameters<typeof runConformance>[0]['adapterFactory'], closeBridge: (() => void) | null = null;
  if (args.mode === 'reference') factory = w => createReferenceAdapter(w);
  else {
    if (!args.config) { out('INVALID CONFIGURATION: --mode external requires --config <file> (see be14-03.external.example.json). No external publisher exists in this workspace; nothing was run.'); return EXIT.INVALID_CONFIG; }
    let cfg; try { cfg = validateExternalConfig(JSON.parse(readFileSync(args.config, 'utf8')), env); } catch (e) { out('INVALID CONFIGURATION: ' + (e as Error).message); return EXIT.INVALID_CONFIG; }
    const bridges: { close(): void }[] = [];                                                        // one bridge process per test session (a test may shut its publisher down)
    factory = () => { const b = createStdioBridgeAdapter({ command: cfg.bridge.command, ...(cfg.bridge.args ? { args: cfg.bridge.args } : {}) }); bridges.push(b); return b; }; closeBridge = () => bridges.forEach(b => b.close());
  }
  try {
    const report = await runConformance({ vectors, mode: args.mode, adapterFactory: factory, ...(args.levels ? { levels: args.levels } : {}), ...(args.only ? { only: args.only } : {}), ...(integrated ? { integrated } : {}), onProgress: r => out(`  ${r.status.padEnd(7)} ${r.testId}  ${r.title}${r.failureCode ? '  [' + r.failureCode + ']' : ''}`) });
    mkdirSync(dirname(resolve(args.report)), { recursive: true }); writeFileSync(args.report, JSON.stringify(report, null, 1)); out(humanSummary(report)); out('report: ' + args.report); return exitCodeFor(report);
  } catch (e) { out('INFRASTRUCTURE UNAVAILABLE: ' + (e as Error).message); return EXIT.INFRASTRUCTURE; } finally { closeBridge?.(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then(c => { process.exitCode = c; });
