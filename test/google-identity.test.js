import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { inspect } from 'node:util';
import { OAuth2Client } from 'google-auth-library';
import { createGoogleIdentityVerifier } from '../dist/src/adapters/google-identity.adapter.js';
import { digestSecret, newOpaqueSecret } from '../dist/src/auth/session-security.js';

// Synthetic cryptographic fixtures only. No Google credentials, private-key file,
// token issuer in src, network request or production acceptance of these keys.
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const audience = '1234567890-offline.apps.googleusercontent.com';
const nonce = newOpaqueSecret();
const seconds = Math.floor(Date.now() / 1000);
const certificates = { fixture: pair.publicKey.export({ type: 'spki', format: 'pem' }) };
function fixture(payload = {}, header = {}, privateKey = pair.privateKey) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = encode({ alg: 'RS256', typ: 'JWT', kid: 'fixture', ...header }) + '.' + encode({
    iss: 'https://accounts.google.com', sub: 'offline-subject', aud: audience,
    iat: seconds - 10, exp: seconds + 600, nonce,
    email: 'offline@example.invalid', email_verified: true, ...payload,
  });
  return input + '.' + sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url');
}
const make = options => createGoogleIdentityVerifier({ audience, now: () => seconds * 1000,
  clockSkewMs: 0, fetchCertificates: async () => certificates, ...options });

test('official Google SDK verifies an offline RS256 signature and adapter returns only stable canonical identity', async () => {
  const result = await make().verify(fixture(), digestSecret(nonce));
  assert.deepEqual(result, { status: 'verified', identity: { issuer: 'https://accounts.google.com', subject: 'offline-subject' } });
  assert.equal(JSON.stringify(result).includes('offline@example.invalid'), false);
  assert.deepEqual(await make().verify(fixture({ iss: 'accounts.google.com' }), digestSecret(nonce)), result);
});
test('invalid signature never produces a verified identity or leaks the credential', async () => {
  const credential = fixture({}, {}, other.privateKey);
  const result = await make().verify(credential, digestSecret(nonce));
  assert.deepEqual(result, { status: 'invalid' });
  assert.equal(inspect(result).includes(credential), false);
});
test('issuer, audience, authorized party and stable subject are checked rather than trusting a decoded profile', async () => {
  for (const claims of [{ iss: 'https://attacker.example.invalid' }, { aud: 'different-client' },
    { aud: [audience] }, { azp: 'different-client' }, { sub: '' }, { sub: ' control\n' }]) {
    assert.deepEqual(await make().verify(fixture(claims), digestSecret(nonce)), { status: 'invalid' });
  }
});
test('expiration, future issued-at, not-before and numeric claim types reject invalid tokens', async () => {
  for (const claims of [{ exp: seconds - 3600 }, { exp: seconds }, { iat: seconds + 120 },
    { nbf: seconds + 1 }, { exp: String(seconds + 600) }, { exp: seconds - 20 }, { iat: seconds + 1000 }]) {
    assert.deepEqual(await make().verify(fixture(claims), digestSecret(nonce)), { status: 'invalid' });
  }
});
test('nonce is bound to the server attempt and unverified email never becomes identity evidence', async () => {
  for (const claims of [{ nonce: newOpaqueSecret() }, { nonce: undefined }, { email_verified: false }]) {
    assert.deepEqual(await make().verify(fixture(claims), digestSecret(nonce)), { status: 'invalid' });
  }
  assert.deepEqual(await make().verify(fixture(), digestSecret(newOpaqueSecret())), { status: 'invalid' });
});
test('malformed, oversized and non-RS256 credentials fail before certificate I/O', async () => {
  let calls = 0;
  const verifier = make({ fetchCertificates: async () => { calls++; return certificates; } });
  for (const token of ['', 'access-token', 'x'.repeat(8193), 'a.b.c', fixture({}, { alg: 'none' }),
    fixture({}, { jku: 'https://attacker.example.invalid/keys' }), null, {}]) {
    assert.deepEqual(await verifier.verify(token, digestSecret(nonce)), { status: 'invalid' });
  }
  assert.equal(calls, 0);
});
test('key retrieval failure is sanitized and a later attempt recovers rather than caching rejection', async () => {
  const privateDiagnostic = 'OFFLINE_PRIVATE_CERT_FAILURE'; let calls = 0;
  const verifier = make({ fetchCertificates: async () => {
    if (++calls === 1) throw new Error(privateDiagnostic); return certificates;
  } });
  await assert.rejects(verifier.verify(fixture(), digestSecret(nonce)), e => e.code === 'DEPENDENCY_UNAVAILABLE' && !inspect(e, { showHidden: true }).includes(privateDiagnostic));
  assert.equal((await verifier.verify(fixture(), digestSecret(nonce))).status, 'verified');
});
test('concurrent verification coalesces certificate retrieval without sharing identity state', async () => {
  let release, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const verifier = make({ fetchCertificates: async () => { calls++; await gate; return certificates; } });
  const pending = Array.from({ length: 8 }, (_, i) => verifier.verify(fixture({ sub: 'user-' + i }), digestSecret(nonce)));
  await Promise.resolve(); release();
  const results = await Promise.all(pending);
  assert.equal(calls, 1); assert.equal(new Set(results.map(r => r.identity.subject)).size, 8);
});
test('unknown key never falls back to arbitrary URL and a trusted rotated key can be used later', async () => {
  let rotated = false;
  const verifier = make({ fetchCertificates: async () => rotated ? { rotated: certificates.fixture } : certificates });
  assert.equal((await verifier.verify(fixture({}, { kid: 'rotated' }), digestSecret(nonce))).status, 'invalid');
  rotated = true;
  assert.equal((await verifier.verify(fixture({}, { kid: 'rotated' }), digestSecret(nonce))).status, 'verified');
});
test('Google adapter configuration fails closed and constructing the real adapter performs no network I/O', () => {
  assert.throws(() => make({ audience: 'not-a-client-id' }), TypeError);
  assert.throws(() => make({ clockSkewMs: 60001 }), TypeError);
  const verifier = createGoogleIdentityVerifier({ audience });
  assert.equal(typeof verifier.verify, 'function');
});

test('C01: real SDK certificate transport disables retries after request options override defaults', async t => {
  const original = OAuth2Client.prototype.getFederatedSignonCertsAsync, observed = [];
  t.mock.method(OAuth2Client.prototype, 'getFederatedSignonCertsAsync', function () {
    this.transporter.defaults.fetchImplementation = async (_url, options) => {
      observed.push({ retry: options.retry, retries: options.retryConfig.retry, timeout: options.timeout });
      return new Response(JSON.stringify(certificates), { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=60' } });
    };
    return original.call(this);
  });
  const verifier = createGoogleIdentityVerifier({ audience, clockSkewMs: 0, now: () => seconds * 1000 });
  assert.equal((await verifier.verify(fixture(), digestSecret(nonce))).status, 'verified');
  assert.deepEqual(observed, [{ retry: false, retries: 0, timeout: 3000 }]);
});

test('C03: actual SDK certificate fetch fails once without retries, sanitizes the failure and then recovers', async t => {
  const original = OAuth2Client.prototype.getFederatedSignonCertsAsync; let calls = 0;
  t.mock.method(OAuth2Client.prototype, 'getFederatedSignonCertsAsync', function () {
    this.transporter.defaults.fetchImplementation = async (_url, options) => {
      calls++; assert.equal(options.headers.has('authorization'), false); assert.ok(options.signal);
      return calls === 1 ? new Response('PRIVATE_CERT_BODY', { status: 503 }) :
        new Response(JSON.stringify(certificates), { headers: { 'content-type': 'application/json', 'cache-control': 'max-age=60' } });
    };
    return original.call(this);
  });
  const verifier = createGoogleIdentityVerifier({ audience });
  await assert.rejects(verifier.verify(fixture(), digestSecret(nonce)), error =>
    error.code === 'DEPENDENCY_UNAVAILABLE' && !inspect(error, { showHidden: true }).includes('PRIVATE_CERT_BODY'));
  assert.equal(calls, 1);
  assert.equal((await verifier.verify(fixture(), digestSecret(nonce))).status, 'verified'); assert.equal(calls, 2);
});

test('C04: real SDK cache expires and rotates signing keys offline without forcing a fetch for arbitrary kids', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: seconds * 1000 });
  const original = OAuth2Client.prototype.getFederatedSignonCertsAsync; let calls = 0;
  t.mock.method(OAuth2Client.prototype, 'getFederatedSignonCertsAsync', function () {
    this.transporter.defaults.fetchImplementation = async () => {
      const keys = ++calls === 1 ? certificates : { rotated: certificates.fixture };
      return new Response(JSON.stringify(keys), { headers: { 'content-type': 'application/json', 'cache-control': 'max-age=1' } });
    };
    return original.call(this);
  });
  const verifier = createGoogleIdentityVerifier({ audience, now: () => Date.now() });
  assert.equal((await verifier.verify(fixture(), digestSecret(nonce))).status, 'verified');
  assert.equal((await verifier.verify(fixture({}, { kid: 'rotated' }), digestSecret(nonce))).status, 'invalid');
  assert.equal(calls, 1);
  t.mock.timers.setTime(seconds * 1000 + 1001);
  assert.equal((await verifier.verify(fixture({}, { kid: 'rotated' }), digestSecret(nonce))).status, 'verified');
  assert.equal(calls, 2);
});
