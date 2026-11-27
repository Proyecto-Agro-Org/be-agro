// BE13-11L — minimal in-memory MongoDB double: just enough `find(filter).sort().limit().toArray()` to run the REAL evidence adapter offline.
// Filter semantics implemented: equality, `null` (matches missing or null, as MongoDB does), `$in`, `$exists`.
const matches = (doc, filter) => Object.entries(filter).every(([k, v]) => {
  const actual = doc[k];
  if (v !== null && typeof v === 'object' && !(v instanceof Date) && !(v instanceof Uint8Array)) {
    if ('$in' in v) return v.$in.includes(actual);
    if ('$exists' in v) return (actual !== undefined) === v.$exists;
    throw new Error('fake-db: unsupported operator ' + JSON.stringify(v));
  }
  return v === null ? actual === undefined || actual === null : actual === v;
});

export function fakeConnection(collections) {
  const queries = [];
  const db = { collection: name => ({
    find: (filter, options) => { queries.push({ name, filter, options }); let rows = (collections[name] ?? []).filter(d => matches(d, filter));
      const cursor = { sort: spec => { const [[k, dir]] = Object.entries(spec); rows = [...rows].sort((a, b) => (a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0) * dir); return cursor; }, limit: n => { rows = rows.slice(0, n); return cursor; }, toArray: async () => rows.map(r => ({ ...r })) };
      return cursor; },
  }) };
  return { connection: { db }, queries };
}
export const bin = text => ({ buffer: Buffer.from(text) });
