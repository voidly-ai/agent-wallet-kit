import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  SPEND_ALLOWANCE_MAX_LIFETIME_SECONDS, assertSpendAllowanceActive,
  assertSpendAllowanceAuthorizationWindow, assertSpendAllowanceQuote,
  canonicalSpendAllowanceGrant, canonicalSpendAllowanceJson, checkedSpendAllowanceGrant,
  checkedSpendAllowanceProof, checkedSpendAllowanceReservation, spendAllowanceBodyHash,
  spendAllowanceSigningMessage, type SpendAllowanceGrant, type SpendAllowanceQuote,
  type SpendAllowanceReservation, type SpendAllowanceSigningInput,
} from '../src/spendAllowance.js';

const NOW = 1_791_374_400; // 2026-10-07 12:00:00 UTC.
const OWNER = `0x${'1'.repeat(40)}` as const;
const PAYEE = `0x${'2'.repeat(40)}` as const;
const ID = '12345678-1234-4234-8234-123456789abc';
const QUOTE = `0x${'3'.repeat(64)}` as const;
const HASH = `0x${'4'.repeat(64)}` as const;
const NONCE = `0x${'5'.repeat(64)}` as const;

function grant(): SpendAllowanceGrant {
  return { version: 'voidpay-spend-allowance/v1', grantId: ID,
    origin: 'https://x402-staging.voidly.ai', network: 'eip155:84532',
    asset: '0x036cbd53842c5426634e7929541ec2318f3dcf7e', owner: OWNER, payer: OWNER,
    dailyLimitAtomic: '100000000', perCallLimitAtomic: '10000000',
    validAfter: NOW - 60, expiresAt: NOW + 86_400,
    listings: [{ listingId: 'service-1234', version: 3, payTo: PAYEE }] };
}

function quote(): SpendAllowanceQuote {
  const g = grant();
  return { quoteId: QUOTE, resourceUrl: `${g.origin}/v1/services/service-1234/call?quote=${QUOTE}`,
    listingId: 'service-1234', listingVersion: 3, payTo: PAYEE, payer: OWNER,
    network: g.network, asset: g.asset, amountAtomic: '1000000', inputSha256: HASH,
    quoteExpiresAt: NOW * 1_000 + 120_000 };
}

function reservation(): SpendAllowanceReservation {
  const q = quote();
  return { ...q, grantId: ID, day: new Date(NOW * 1_000).toISOString().slice(0, 10),
    reservedUntil: q.quoteExpiresAt, paymentKey: null };
}

test('grant validation enforces caps, exact network, owner, lifetime and explicit listing triples', () => {
  assert.deepEqual(checkedSpendAllowanceGrant(grant()), grant());
  const cases = [
    { dailyLimitAtomic: '100000001' }, { perCallLimitAtomic: '10000001' },
    { perCallLimitAtomic: '000001' }, { perCallLimitAtomic: '1.0' },
    { perCallLimitAtomic: 1 }, { dailyLimitAtomic: '999', perCallLimitAtomic: '1000' },
    { dailyLimitAtomic: '0' }, { payer: PAYEE }, { owner: `0x${'0'.repeat(40)}` },
    { origin: 'https://x402.voidly.ai' }, { origin: 'https://x402-staging.voidly.ai/' },
    { asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' },
    { grantId: ID.toUpperCase() }, { expiresAt: NOW - 60 },
    { expiresAt: NOW - 60 + SPEND_ALLOWANCE_MAX_LIFETIME_SECONDS + 1 },
    { validAfter: NOW + 0.5 }, { listings: [] }, { listings: Array(33).fill(grant().listings[0]) },
    { listings: [grant().listings[0], grant().listings[0]] },
    { listings: [{ listingId: '*', version: 3, payTo: PAYEE }] },
    { listings: [{ listingId: 'service-1234', version: 0, payTo: PAYEE }] },
    { listings: [{ listingId: 'service-1234', version: 3, payTo: { private: 'secret' } }] },
    { wildcard: true },
  ];
  for (const patch of cases) assert.throws(() => checkedSpendAllowanceGrant({ ...grant(), ...patch }));
  const copy = checkedSpendAllowanceGrant(grant());
  copy.listings[0]!.version = 10;
  assert.equal(grant().listings[0]!.version, 3);
  const mainnet = { ...grant(), network: 'eip155:8453', origin: 'https://x402.voidly.ai',
    asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' };
  assert.equal(checkedSpendAllowanceGrant(mainnet).network, 'eip155:8453');
});

test('stored grants remain readable while active checks enforce inclusive start and exclusive expiry', () => {
  const g = grant();
  assert.deepEqual(assertSpendAllowanceActive(g, g.validAfter), g);
  assert.throws(() => assertSpendAllowanceActive(g, g.validAfter - 1));
  assert.throws(() => assertSpendAllowanceActive(g, g.expiresAt));
  assert.throws(() => assertSpendAllowanceActive(g, NaN));
  assert.deepEqual(checkedSpendAllowanceGrant(g), g);
});

test('canonical digest is stable across field order and rejects JSON ambiguities without accessing getters', async () => {
  const reversed = Object.fromEntries(Object.entries(grant()).reverse());
  assert.equal(canonicalSpendAllowanceGrant(reversed), canonicalSpendAllowanceGrant(grant()));
  assert.equal(await spendAllowanceBodyHash(grant()),
    `0x${createHash('sha256').update(canonicalSpendAllowanceGrant(grant())).digest('hex')}`);
  assert.equal(await spendAllowanceBodyHash({ quoteId: QUOTE }),
    `0x${createHash('sha256').update(`{"quoteId":"${QUOTE}"}`).digest('hex')}`);
  let accesses = 0;
  const getter = Object.defineProperty({}, 'secret', { enumerable: true, get() { accesses++; return 'secret'; } });
  const accessorArray = Object.defineProperty([0], '0', { enumerable: true, get() { accesses++; return 'secret'; } });
  for (const invalid of [undefined, { a: undefined }, NaN, Infinity, 1.1, -0, 1n, new Date(),
    { toJSON: () => ({ safe: true }) }, new Set(), [,,], getter, accessorArray,
    Object.assign({}, { [Symbol('hidden')]: true }), 'a'.repeat(8_193), Array(1025).fill(null)]) {
    assert.throws(() => canonicalSpendAllowanceJson(invalid));
  }
  assert.equal(accesses, 0);
  let nested: unknown = null;
  for (let i = 0; i < 18; i++) nested = [nested];
  assert.throws(() => canonicalSpendAllowanceJson(nested));
  assert.equal(canonicalSpendAllowanceJson({ b: [3, false, null], a: true }), '{"a":true,"b":[3,false,null]}');
});

test('EIP-191 message binds action, route, grant, body, nonce and a bounded Unix-second expiry', () => {
  const p: SpendAllowanceSigningInput = { action: 'reserve', network: grant().network,
    origin: grant().origin, grantId: ID, bodyHash: HASH, nonce: NONCE, expiresAt: NOW + 300 };
  assert.equal(spendAllowanceSigningMessage(p, NOW),
    ['voidpay-spend-allowance-proof/v1', 'reserve', 'eip155:84532', grant().origin,
      ID, HASH, NONCE, NOW + 300].join('\n'));
  for (const action of ['grant', 'status', 'revoke', 'reserve'] as const) {
    assert.match(spendAllowanceSigningMessage({ ...p, action }, NOW), new RegExp(`\\n${action}\\n`));
  }
  for (const patch of [{ expiresAt: NOW }, { expiresAt: NOW + 301 }, { expiresAt: NOW * 1_000 },
    { nonce: '5'.repeat(64) }, { bodyHash: HASH.toUpperCase() }, { action: 'bind' },
    { origin: 'https://x402.voidly.ai' }, { extra: true }]) {
    assert.throws(() => spendAllowanceSigningMessage({ ...p, ...patch } as SpendAllowanceSigningInput, NOW));
  }
  assert.deepEqual(checkedSpendAllowanceProof({ nonce: NONCE, expiresAt: NOW + 30,
    signature: `0x${'6'.repeat(130)}` }, NOW),
  { nonce: NONCE, expiresAt: NOW + 30, signature: `0x${'6'.repeat(130)}` });
  assert.throws(() => checkedSpendAllowanceProof({ nonce: NONCE, expiresAt: NOW + 30,
    signature: `0x${'6'.repeat(128)}` }, NOW));
});

test('quote checks bind the original resource and exact allowed seller version before signing', () => {
  assert.deepEqual(assertSpendAllowanceQuote(grant(), quote(), NOW * 1_000), quote());
  for (const patch of [{ listingVersion: 4 }, { payTo: OWNER }, { payer: PAYEE },
    { network: 'eip155:8453' }, { amountAtomic: '10000001' }, { amountAtomic: '01' },
    { asset: OWNER }, { quoteExpiresAt: NOW * 1_000 }, { inputSha256: 'anything' },
    { resourceUrl: `${quote().resourceUrl}&retry=true` },
    { resourceUrl: quote().resourceUrl.replace('x402-staging.voidly.ai', 'untrusted.example') },
    { quoteId: HASH }, { listingId: 'service-9999' }, { amountAtomic: { value: '1' } }]) {
    assert.throws(() => assertSpendAllowanceQuote(grant(), { ...quote(), ...patch }, NOW * 1_000));
  }
});

test('reservation checks prevent quote substitution, payment-key replacement and budget-day rollover', () => {
  assert.deepEqual(checkedSpendAllowanceReservation(grant(), quote(), reservation(), NOW * 1_000), reservation());
  for (const patch of [{ grantId: ID.replace('12345678', '87654321') }, { quoteId: HASH },
    { paymentKey: HASH }, { day: '2026-10-08' }, { reservedUntil: quote().quoteExpiresAt + 1 },
    { payer: PAYEE }, { amountAtomic: '999' }, { inputSha256: QUOTE }]) {
    assert.throws(() => checkedSpendAllowanceReservation(grant(), quote(), { ...reservation(), ...patch }, NOW * 1_000));
  }
  const midnight = Date.parse(`${reservation().day}T00:00:00.000Z`) + 86_400_000;
  const nearMidnight = midnight - 30_000;
  const q = { ...quote(), quoteExpiresAt: midnight + 90_000 };
  const r = { ...reservation(), ...q, reservedUntil: midnight };
  assert.deepEqual(checkedSpendAllowanceReservation(grant(), q, r, nearMidnight), r);
  assert.throws(() => assertSpendAllowanceAuthorizationWindow(r, nearMidnight / 1_000 + 120, nearMidnight));
  assert.doesNotThrow(() => assertSpendAllowanceAuthorizationWindow(r, midnight / 1_000, nearMidnight));
  assert.throws(() => checkedSpendAllowanceReservation(grant(), q, r, midnight));
  const expiring = { ...grant(), expiresAt: NOW + 50 };
  const clipped = { ...reservation(), reservedUntil: expiring.expiresAt * 1_000 };
  assert.deepEqual(checkedSpendAllowanceReservation(expiring, quote(), clipped, NOW * 1_000), clipped);
  assert.throws(() => assertSpendAllowanceAuthorizationWindow(clipped, NOW + 120, NOW * 1_000));
  assert.throws(() => assertSpendAllowanceAuthorizationWindow(clipped, NOW, NOW * 1_000));
});
