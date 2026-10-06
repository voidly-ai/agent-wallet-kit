import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import type { MarketplaceAttempt } from '../src/marketplaceRecovery.js';
import {
  MARKETPLACE_RECEIPT_KEYS_URL,
  verifyMarketplaceOutcome,
} from '../src/marketplaceReceiptVerification.js';

const quoteId = `0x${'11'.repeat(32)}` as const;
const paymentKey = `0x${'22'.repeat(32)}` as const;
const wallet = `0x${'33'.repeat(20)}` as const;
const payTo = `0x${'44'.repeat(20)}` as const;
const asset = '0x036cbd53842c5426634e7929541ec2318f3dcf7e' as const;
const transactionHash = `0x${'55'.repeat(32)}` as const;
const inputSha256 = `0x${'66'.repeat(32)}` as const;
const quoteUrl = `https://x402.voidly.ai/v1/services/svc_demo01/call?quote=${quoteId}`;
const deliveredBody = Buffer.from('{"ok":true}', 'utf8');
const sha256 = (bytes: Uint8Array) => `0x${createHash('sha256').update(bytes).digest('hex')}`;

const attempt: MarketplaceAttempt = {
  version: 1, quoteId, paymentKey, wallet, payTo, asset,
  network: 'eip155:84532', listingId: 'svc_demo01', listingVersion: 3,
  targetUrl: 'https://x402.voidly.ai/v1/services/svc_demo01/call',
  quoteUrl, amountAtomic: '2000000', requestBodySha256: sha256(Buffer.from('{"prompt":"hello"}')),
  quotedInputSha256: inputSha256, createdAt: new Date(1_600_000_000_000).toISOString(),
};

const keys = generateKeyPairSync('ed25519'); // Synthetic key only; no gateway or wallet secret.
const publicKeySpki = Buffer.from(keys.publicKey.export({ format: 'der', type: 'spki' }) as Uint8Array)
  .toString('base64url');
const payload = {
  version: 'voidpay-x402-delivery-v1', keyVersion: 1, network: attempt.network,
  asset, transactionHash, payerWallet: wallet, payTo, amountAtomic: '2000000',
  resourceUrl: quoteUrl, context: null, blockNumber: '256', confirmationsAtDelivery: 2,
  listingId: attempt.listingId, listingVersion: 3,
  inputSha256, outputSha256: sha256(deliveredBody), deliveredAt: 1_600_000_000_100,
  status: 'delivered', quoteId, quoteExpiresAt: 1_600_000_000_050,
  paymentKey, outputSchemaMatched: true, failureCode: null,
  outcomeAt: 1_600_000_000_100,
} as const;

function signed(changes: Record<string, unknown> = {}) {
  const values = { ...payload, ...changes };
  const canonical = `{${Object.keys(values).sort().map(key =>
    `${JSON.stringify(key)}:${JSON.stringify(values[key as keyof typeof values])}`).join(',')}}`;
  const signature = sign(null, Buffer.from(canonical), keys.privateKey).toString('base64url');
  const receipt = { ...values, signature };
  const header = Buffer.from(`{${Object.keys(receipt).sort().map(key =>
    `${JSON.stringify(key)}:${JSON.stringify(receipt[key as keyof typeof receipt])}`).join(',')}}`)
    .toString('base64url');
  return { receipt, header };
}

function registry(keySpki = publicKeySpki, overrides: Record<string, unknown> = {}): object {
  return {
    version: 'voidpay-receipt-keys-v1', activeKeyVersion: 1,
    keys: [{ keyVersion: 1, algorithm: 'Ed25519', publicKeySpki: keySpki,
      status: 'active' }], ...overrides,
  };
}

function registryFetcher(body: object = registry()): typeof fetch {
  return async (input, init) => {
    assert.equal(input, MARKETPLACE_RECEIPT_KEYS_URL);
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'manual');
    return Response.json(body);
  };
}

function delivered(header: string, bytes: Uint8Array = deliveredBody): Response {
  return new Response(bytes, { status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8',
      'x-voidpay-delivery-receipt': header } });
}

test('delivered receipt verifies fixed-origin Ed25519 key, attempt and exact body bytes', async () => {
  const { header } = signed();
  const response = delivered(header);
  const result = await verifyMarketplaceOutcome(response, attempt, 'paid', registryFetcher());
  assert.equal(result.status, 'delivered');
  assert.equal(result.receipt.paymentKey, paymentKey);
  assert.equal(await response.text(), deliveredBody.toString('utf8'),
    'verification leaves the original response readable');
  assert.equal((await verifyMarketplaceOutcome(delivered(header), attempt,
    'recovery', registryFetcher())).status, 'delivered');
});

test('precomputed signed receipt verifies the 24-field signature and canonical job context', async () => {
  // Only the public SPKI, encoded receipt and body are stored in this synthetic fixture.
  const fixture = JSON.parse(await readFile(new URL('./fixtures/gateway-signed-receipt.json',
    import.meta.url), 'utf8')) as { publicKeySpki: string; header: string; body: string };
  const response = delivered(fixture.header, Buffer.from(fixture.body));
  const result = await verifyMarketplaceOutcome(response, attempt, 'paid',
    registryFetcher(registry(fixture.publicKeySpki)));
  assert.deepEqual(result.receipt.context, {
    legId: '33333333-3333-4333-8333-333333333333',
    jobId: '11111111-1111-4111-8111-111111111111',
    awardId: '22222222-2222-4222-8222-222222222222',
  });
  assert.equal(result.receipt.blockNumber, '256');
  assert.equal(result.receipt.confirmationsAtDelivery, 2);
});

test('signed refund owed is verified on paid 502 and recovery 200', async () => {
  const { receipt, header } = signed({ status: 'refund_owed', outputSha256: null,
    outputSchemaMatched: null, deliveredAt: null, failureCode: 'upstream_failed' });
  const headers = { 'content-type': 'application/json; charset=utf-8',
    'x-voidpay-delivery-receipt': header };
  const paid = Response.json({ error: 'seller_delivery_failed', refund_owed: true,
    refund_reference: transactionHash }, { status: 502, headers });
  const recovered = Response.json({ status: 'refund_owed', refund_owed: true,
    refund_reference: transactionHash, receipt }, { status: 200, headers });
  assert.equal((await verifyMarketplaceOutcome(paid, attempt, 'paid', registryFetcher())).status,
    'refund_owed');
  assert.equal((await verifyMarketplaceOutcome(recovered, attempt, 'recovery', registryFetcher())).status,
    'refund_owed');
});

test('tampered signature, body, attempt and key source fail closed', async () => {
  const { header } = signed();
  const tampered = Buffer.from(header, 'base64url').toString('utf8')
    .replace('"signature":"', '"signature":"x');
  await assert.rejects(verifyMarketplaceOutcome(delivered(Buffer.from(tampered).toString('base64url')),
    attempt, 'paid', registryFetcher()), /verification failed/);
  await assert.rejects(verifyMarketplaceOutcome(delivered(header, Buffer.from('{"ok":false}')),
    attempt, 'paid', registryFetcher()), /body hash mismatch/);
  await assert.rejects(verifyMarketplaceOutcome(delivered(header),
    { ...attempt, paymentKey: `0x${'99'.repeat(32)}` }, 'paid', registryFetcher()),
  /does not match/);
  const otherKey = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' });
  await assert.rejects(verifyMarketplaceOutcome(delivered(header), attempt, 'paid',
    registryFetcher(registry(Buffer.from(otherKey).toString('base64url')))), /signature/);
  await assert.rejects(verifyMarketplaceOutcome(delivered(header), attempt, 'paid',
    registryFetcher(registry(publicKeySpki, { privateKey: 'forbidden' }))), /registry/);
});

test('missing receipt, wrong status, refund mismatch and oversized body fail closed', async () => {
  const { header } = signed();
  await assert.rejects(verifyMarketplaceOutcome(Response.json({ ok: true }),
    attempt, 'paid', registryFetcher()), /missing signed receipt/);
  await assert.rejects(verifyMarketplaceOutcome(new Response(deliveredBody, { status: 302,
    headers: { 'content-type': 'application/json', 'x-voidpay-delivery-receipt': header } }),
  attempt, 'paid', registryFetcher()), /status/);
  await assert.rejects(verifyMarketplaceOutcome(delivered(header, Buffer.alloc(1_048_577)),
    attempt, 'paid', registryFetcher()), /exceeds limit/);
  const refund = signed({ status: 'refund_owed', outputSha256: null,
    outputSchemaMatched: null, deliveredAt: null, failureCode: 'upstream_failed' });
  await assert.rejects(verifyMarketplaceOutcome(Response.json({ status: 'refund_owed',
    refund_owed: true, refund_reference: `0x${'88'.repeat(32)}`, receipt: refund.receipt },
  { status: 200, headers: { 'x-voidpay-delivery-receipt': refund.header } }), attempt,
  'recovery', registryFetcher()), /refund body/);
});

test('receipt proof fields and nested refund context are checked', async () => {
  for (const changes of [
    { blockNumber: '0' }, { blockNumber: '01' },
    { confirmationsAtDelivery: 0 },
    { context: { jobId: 'invalid', awardId: 'invalid', legId: 'invalid' } },
  ]) {
    const { header } = signed(changes);
    await assert.rejects(verifyMarketplaceOutcome(delivered(header), attempt,
      'paid', registryFetcher()), /invalid receipt payload/);
  }
  const context = {
    jobId: '11111111-1111-4111-8111-111111111111',
    awardId: '22222222-2222-4222-8222-222222222222',
    legId: '33333333-3333-4333-8333-333333333333',
  };
  const refund = signed({ status: 'refund_owed', outputSha256: null,
    outputSchemaMatched: null, deliveredAt: null, failureCode: 'upstream_failed', context });
  const altered = { ...refund.receipt, context: { ...context, legId: context.jobId } };
  await assert.rejects(verifyMarketplaceOutcome(Response.json({ status: 'refund_owed',
    refund_owed: true, refund_reference: transactionHash, receipt: altered },
  { status: 200, headers: { 'x-voidpay-delivery-receipt': refund.header } }), attempt,
  'recovery', registryFetcher()), /refund body/);
});
