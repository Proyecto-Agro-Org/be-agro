// BE14-03 — a MINIMAL stdio bridge used ONLY by the kit's own tests to exercise the external-adapter protocol. It is NOT a publisher and does not publish anything:
// it only keeps readings in memory so that world-independent tests (L0) can run in external mode. It never talks to MQTT or HTTP.
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';

const ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/; let cfg = null, seq = 1; const entries = [];
const reply = (id, ok, v) => process.stdout.write(JSON.stringify(ok ? { id, ok, result: v } : { id, ok, error: v }) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  const { id, op, args } = JSON.parse(line);
  if (process.env.MOCK_BRIDGE_HANG === op) return;                                           // simulate a hung publisher
  if (op === 'capabilities') return reply(id, true, ['explicit-event-input']);
  if (op === 'boot') { cfg = args; return reply(id, true, { ok: true }); }
  if (op === 'createEvent') {
    const eventId = args.eventId ?? `${cfg.technicalKey}:${seq++}`; if (!ID.test(eventId)) return reply(id, true, { result: 'rejected', reason: 'INVALID_EVENT_ID' });
    const dt = args.deviceTimestamp === undefined ? 1795115599000 : args.deviceTimestamp; if (!(typeof dt === 'number' && Number.isSafeInteger(dt) && dt >= 0)) return reply(id, true, { result: 'rejected', reason: 'INVALID_DEVICE_TIMESTAMP' });
    for (const [k, v] of Object.entries(args.payload)) if (!/^[a-z][a-z0-9_]{0,63}$/.test(k) || (v !== null && typeof v === 'object')) return reply(id, true, { result: 'rejected', reason: 'INVALID_READING' });
    const bytes = Buffer.from(JSON.stringify({ version: 1, eventId, sentAt: args.sentAt ?? 1795115600000, clientid: cfg.technicalKey, deviceTimestamp: dt, payload: args.payload, mqtt: { topic: cfg.topic, messageType: 'telemetry', dataOrigin: 'simulated' } }));
    const sha = createHash('sha256').update(bytes).digest('hex'), prior = entries.find(e => e.eventId === eventId); if (prior) return reply(id, true, prior.payloadSha256 === sha ? { result: 'accepted', eventId } : { result: 'rejected', reason: 'EVENT_ID_REUSED_WITH_OTHER_BYTES' });
    entries.push({ eventId, payloadSha256: sha, payloadB64: bytes.toString('base64'), state: 'pending', lane: 'fast', attempts: 0 }); return reply(id, true, { result: 'accepted', eventId });
  }
  if (op === 'inspectPending') return reply(id, true, entries); if (op === 'advance') return reply(id, true, null); if (op === 'restart') return reply(id, true, { ok: true });
  if (op === 'shutdown') { reply(id, true, null); return process.exit(0); }
  return reply(id, false, 'unknown op ' + op);
});
