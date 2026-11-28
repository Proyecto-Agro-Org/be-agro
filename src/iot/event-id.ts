import { z } from 'zod';

// BE14-02 — THE ONLY definition of `eventId` for the whole pipeline: publisher, payload parser, trust gate, protected ingest, Durable Inbox, quarantine scope,
// reconciliation API and tooling. Nothing else may spell this regex; everything imports from here.
//
//   length     1..128 characters (MQTT/HTTP/log/firmware friendly; Mongo unique-index keys stay far below 1024 bytes; the HTTP route limit is 1024 chars)
//   charset    ASCII letters and digits, plus ':' '_' '-' after the first character
//   first char letter or digit
//   case       SENSITIVE (identity is exact)
//   NOT allowed: '.', '/', '\', space or any whitespace, control characters (tab, CR/LF, NUL), non-ASCII/Unicode, '%', quotes, '$', '{', '}' ...
//
// Why no '.': it has never been accepted by the real ingestion path (the payload parser rejects it, so no event with a '.' can exist in the Durable Inbox, the
// idempotency claims or the measurements), and the sibling iot-ingest service uses '.' as a key delimiter. The reconciliation API used to be MORE permissive
// than the parser (BE14-01 finding): it would answer about ids that could never be ingested. Identity is exact: no normalisation of any kind is ever applied.
export const EVENT_ID_MIN_LENGTH = 1;
export const EVENT_ID_MAX_LENGTH = 128;
export const EVENT_ID_PATTERN_SOURCE = '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$';
export const EVENT_ID_PATTERN = new RegExp(EVENT_ID_PATTERN_SOURCE);

export function isValidEventId(value: unknown): value is string { return typeof value === 'string' && EVENT_ID_PATTERN.test(value); }
/** Returns the SAME string (never a normalised copy) or throws a stable, input-free error. */
export function validateEventId(value: unknown): string { if (!isValidEventId(value)) throw new TypeError('INVALID_EVENT_ID'); return value; }
export const eventIdSchema = z.string().regex(EVENT_ID_PATTERN);
