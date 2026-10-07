import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign as signBytes } from 'node:crypto';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentRequired } from '@x402/core/types';
import { getDefaultAsset } from '@x402/evm';
import { keccak256, stringToBytes } from 'viem';
import {
  AgentWallet,
  FileSpendStore,
  FileMarketplaceAttemptStore,
  MemoryMarketplaceAttemptStore,
  LocalWalletBackupStore,
  MemorySpendStore,
  RelayWalletBackupStore,
  decryptWalletBackup,
  encryptWalletBackup,
  generateRecoverySecret,
  isGeneratedRecoverySecret,
  type EncryptedWalletBackup,
} from '../src/index.js';

const PAYER = '0x1111111111111111111111111111111111111111' as const;
const PAYEE = '0x2222222222222222222222222222222222222222';
const CALL_URL = 'https://x402.example.test/v1/services/echo/call';
const QUOTE_URL = `${CALL_URL}?quote=0x${'a'.repeat(64)}`;
const USDC = getDefaultAsset('eip155:84532').asset;
const digest = (value: string) => `0x${createHash('sha256').update(value).digest('hex')}`;
const syntheticRecoverySecret = (byte: number) => `voidly-rs-v1-${Buffer.alloc(32, byte).toString('base64url')}`;

function challenge(amount: string, resourceUrl = QUOTE_URL, asset = USDC): PaymentRequired {
  return {
    x402Version: 2,
    resource: { url: resourceUrl },
    accepts: [{
      scheme: 'exact', network: 'eip155:84532', asset, amount, payTo: PAYEE,
      maxTimeoutSeconds: 120, extra: { name: 'USDC', version: '2' },
    }],
  };
}

function fixture(quote: PaymentRequired) {
  let fetches = 0;
  let signs = 0;
  const signatures: ReturnType<typeof decodePaymentSignatureHeader>[] = [];
  const signer = {
    address: PAYER,
    async signTypedData({ domain }: { domain: Record<string, unknown> }) {
      signs++;
      assert.equal(domain.chainId, 84532);
      return `0x${'11'.repeat(64)}1b` as `0x${string}`; // inert bytes, not a wallet signature
    },
  };
  const fetcher: typeof fetch = async input => {
    const request = new Request(input);
    fetches++;
    assert.equal(request.url, CALL_URL);
    assert.equal(request.method, 'POST');
    assert.deepEqual(await request.json(), { prompt: 'echo' });
    assert.equal(request.headers.get('x-voidpay-intent-signature'), null);
    const signature = request.headers.get('payment-signature');
    if (!signature) {
      return new Response('{}', { status: 402, headers: { 'payment-required': encodePaymentRequiredHeader(quote) } });
    }
    signatures.push(decodePaymentSignatureHeader(signature));
    return Response.json({ delivered: true });
  };
  return { signer, fetcher, signatures, counts: () => ({ fetches, signs }) };
}

test('stock x402 fetch pays once with a quote URL and local pre-signing limit', async () => {
  const mock = fixture(challenge('10000'));
  const ledger = new MemorySpendStore();
  const wallet = AgentWallet.fromSigner(mock.signer, {
    network: 'base-sepolia',
    limits: { perCallUsd: '0.02', dailyUsd: '0.03' },
    spendStore: ledger,
    unsafeAllowVolatileSpendStoreForTests: true,
    allowedOrigins: ['https://x402.example.test'],
    fetcher: mock.fetcher,
  });
  const response = await wallet.payX402({ url: CALL_URL, method: 'POST', body: { prompt: 'echo' } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { delivered: true });
  assert.deepEqual(mock.counts(), { fetches: 2, signs: 1 });
  assert.equal(mock.signatures[0]?.resource?.url, QUOTE_URL);
  assert.equal(mock.signatures[0]?.accepted.amount, '10000');
  assert.equal(mock.signatures[0]?.payload.signature, `0x${'11'.repeat(64)}1b`);
  assert.equal((await ledger.reserve({ wallet: PAYER, network: 'base-sepolia', amountAtomic: 20_000n, dailyLimitAtomic: 30_000n })).reservedAtomic, 30_000n);
  await assert.rejects(wallet.payX402({ url: CALL_URL, method: 'POST', body: { prompt: 'echo' } }), /Daily USDC authorization limit exceeded/);
  assert.deepEqual(mock.counts(), { fetches: 3, signs: 1 });
});

for (const origin of ['https://x402.voidly.ai', 'https://x402-staging.voidly.ai']) {
test(`Marketplace attempt is durable before paid retry and recovers from ${origin}`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'voidly-agent-wallet-marketplace-'));
  try {
    const listingId = 'echo1234';
    const callUrl = `${origin}/v1/services/${listingId}/call`;
    const quoteId = `0x${'a'.repeat(64)}`;
    const quoteUrl = `${callUrl}?quote=${quoteId}`;
    const body = { prompt: 'echo', count: 1 };
    const wireBody = JSON.stringify(body);
    const quotedInputSha256 = digest('{"count":1,"prompt":"echo"}');
    const required = challenge('10000', quoteUrl);
    required.accepts[0]!.extra = {
      ...required.accepts[0]!.extra, assetTransferMethod: 'eip3009', paymentFlow: 'upfront',
    };
    const intent = {
      version: 1, listingId, listingVersion: 4, quoteId, resource: quoteUrl,
      inputDigest: quotedInputSha256, sellerWallet: PAYEE, amountAtomic: '10000',
    };
    required.extensions = { 'voidpay.intent': {
      info: intent, schema: { type: 'object', properties: { version: { const: 1 } } },
    } };
    const attemptStore = new FileMarketplaceAttemptStore(directory);
    const spendStore = new FileSpendStore(directory);
    await spendStore.initialize(PAYER, 'base-sepolia');
    let paidFetches = 0;
    let recoveryFetches = 0;
    let signs = 0;
    let recoverySigns = 0;
    let registryFetches = 0;
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const registry = {
      version: 'voidpay-receipt-keys-v1', activeKeyVersion: 1,
      keys: [{ keyVersion: 1, algorithm: 'Ed25519',
        publicKeySpki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'), status: 'active' }],
    };
    const responseBody = JSON.stringify({ delivered: true });
    let signedReceiptHeader = '';
    const signer = {
      address: PAYER,
      async signTypedData() {
        signs++;
        return `0x${'11'.repeat(64)}1b` as `0x${string}`;
      },
      async signMessage({ message }: { message: string }) {
        recoverySigns++;
        const attempts = await attemptStore.list(PAYER, 'eip155:84532');
        assert.equal(message, `Voidpay Marketplace recovery v1\nchainId:84532\npaymentKey:${attempts[0]?.paymentKey}\nquoteId:${quoteId}`);
        return `0x${'22'.repeat(65)}` as `0x${string}`; // inert source-test bytes
      },
    };
    const fetcher: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.url === `${origin}/.well-known/voidpay-receipt-keys.json`) {
        registryFetches++;
        return Response.json(registry);
      }
      if (request.method === 'GET') {
        recoveryFetches++;
        assert.equal(request.url, `${origin}/v1/services/${listingId}/quotes/${quoteId}/result`);
        assert.equal(request.headers.get('x-voidpay-recovery-signature'), `0x${'22'.repeat(65)}`);
        assert.equal(request.headers.get('payment-signature'), null);
        return new Response(responseBody, { status: 200, headers: {
          'content-type': 'application/json', 'x-voidpay-delivery-receipt': signedReceiptHeader,
        } });
      }
      paidFetches++;
      assert.equal(request.url, callUrl);
      assert.equal(await request.text(), wireBody);
      if (!request.headers.has('payment-signature')) {
        return new Response('{}', { status: 402, headers: { 'payment-required': encodePaymentRequiredHeader(required) } });
      }
      const attempts = await attemptStore.list(PAYER, 'eip155:84532');
      assert.equal(attempts.length, 1, 'attempt must be fsynced before the paid retry');
      const payment = decodePaymentSignatureHeader(request.headers.get('payment-signature')!);
      assert.deepEqual(payment.extensions?.['voidpay.intent'], required.extensions?.['voidpay.intent']);
      const nonce = String((payment.payload.authorization as { nonce: string }).nonce);
      assert.equal(attempts[0]?.paymentKey, keccak256(stringToBytes([
        'eip155:84532', USDC.toLowerCase(), PAYER.toLowerCase(), nonce.toLowerCase(),
      ].join('|'))));
      const attempt = attempts[0]!;
      const outcomeAt = Date.now();
      const payload = {
        version: 'voidpay-x402-delivery-v1', keyVersion: 1,
        network: attempt.network, asset: attempt.asset,
        transactionHash: `0x${'d'.repeat(64)}`, payerWallet: attempt.wallet,
        payTo: attempt.payTo, amountAtomic: attempt.amountAtomic,
        resourceUrl: attempt.quoteUrl, listingId: attempt.listingId,
        listingVersion: attempt.listingVersion, inputSha256: attempt.quotedInputSha256,
        context: null, blockNumber: '256', confirmationsAtDelivery: 2,
        outputSha256: digest(responseBody), deliveredAt: outcomeAt,
        status: 'delivered', quoteId: attempt.quoteId,
        quoteExpiresAt: outcomeAt + 120_000, paymentKey: attempt.paymentKey,
        outputSchemaMatched: true, failureCode: null, outcomeAt,
      };
      const canonical = `{${Object.keys(payload).sort().map(key =>
        `${JSON.stringify(key)}:${JSON.stringify(payload[key as keyof typeof payload])}`).join(',')}}`;
      const signature = signBytes(null, Buffer.from(canonical), privateKey).toString('base64url');
      const signed = { ...payload, signature };
      signedReceiptHeader = Buffer.from(`{${Object.keys(signed).sort().map(key =>
        `${JSON.stringify(key)}:${JSON.stringify(signed[key as keyof typeof signed])}`).join(',')}}`).toString('base64url');
      return new Response(responseBody, { status: 200, headers: {
        'content-type': 'application/json', 'x-voidpay-delivery-receipt': signedReceiptHeader,
      } });
    };
    const wallet = AgentWallet.fromSigner(signer, {
      network: 'base-sepolia', limits: { perCallUsd: '0.02', dailyUsd: '0.03' },
      spendStore, marketplaceAttemptStore: attemptStore, fetcher,
    });
    const paid = await wallet.payX402({ url: callUrl, method: 'POST', body,
      expectedMarketplace: { listingId, version: 4, payTo: PAYEE } });
    assert.equal(paid.status, 200);
    assert.deepEqual({ paidFetches, signs }, { paidFetches: 2, signs: 1 });
    const saved = (await wallet.marketplaceAttempts()).find(item => item.quoteId === quoteId)!;
    assert.equal(saved.quoteId, quoteId);
    assert.equal(saved.quoteUrl, quoteUrl);
    assert.equal(saved.quotedInputSha256, quotedInputSha256);
    assert.equal(saved.requestBodySha256, digest(wireBody));
    const recovered = await wallet.recoverMarketplace(quoteId);
    assert.equal(recovered.response.status, 200);
    assert.equal(recovered.verifiedStatus, 'delivered');
    assert.equal(recovered.archivePending, false);
    assert.deepEqual({ recoveryFetches, recoverySigns, registryFetches },
      { recoveryFetches: 1, recoverySigns: 1, registryFetches: 2 });
    attemptStore.markTerminal = async () => { throw new Error('synthetic archive lock failure'); };
    const unarchived = await wallet.recoverMarketplace(quoteId);
    assert.equal(unarchived.response.status, 200);
    assert.equal(unarchived.verifiedStatus, 'delivered');
    assert.equal(unarchived.archivePending, true);
    assert.equal(unarchived.quoteId, quoteId);
    assert.deepEqual({ recoveryFetches, recoverySigns, registryFetches },
      { recoveryFetches: 2, recoverySigns: 2, registryFetches: 3 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
}

test('Marketplace refuses missing or failed attempt persistence before a paid retry', async () => {
  const listingId = 'echo1234';
  const callUrl = `https://x402.voidly.ai/v1/services/${listingId}/call`;
  const quoteId = `0x${'a'.repeat(64)}`;
  const quoteUrl = `${callUrl}?quote=${quoteId}`;
  const body = { prompt: 'echo' };
  const required = challenge('10000', quoteUrl);
  required.accepts[0]!.extra = {
    ...required.accepts[0]!.extra, assetTransferMethod: 'eip3009', paymentFlow: 'upfront',
  };
  required.extensions = { 'voidpay.intent': {
    version: 1, listingId, listingVersion: 4, quoteId, resource: quoteUrl,
    inputDigest: digest(JSON.stringify(body)), sellerWallet: PAYEE, amountAtomic: '10000',
  } };
  let fetches = 0;
  let signs = 0;
  const fetcher: typeof fetch = async () => {
    fetches++;
    if (fetches > 1) throw new Error('Paid retry escaped before durable save');
    return new Response('{}', { status: 402, headers: { 'payment-required': encodePaymentRequiredHeader(required) } });
  };
  const signer = {
    address: PAYER,
    async signTypedData() { signs++; return `0x${'11'.repeat(64)}1b` as `0x${string}`; },
  };
  const options = {
    network: 'base-sepolia' as const, limits: { perCallUsd: '0.02', dailyUsd: '0.03' },
    spendStore: new MemorySpendStore(), unsafeAllowVolatileSpendStoreForTests: true, fetcher,
  };
  const missing = AgentWallet.fromSigner(signer, options);
  await assert.rejects(missing.payX402({ url: callUrl, method: 'POST', body }), /durable attempt store/);
  assert.deepEqual({ fetches, signs }, { fetches: 0, signs: 0 });
  const unavailable = AgentWallet.fromSigner(signer, {
    ...options,
    marketplaceAttemptStore: {
      kind: 'durable' as const,
      async ensureCapacity() {},
      async save() { throw new Error('Synthetic durable write failed'); },
      async list() { return []; },
      async get() { return null; },
      async markTerminal() {},
    },
  });
  await assert.rejects(unavailable.payX402({ url: callUrl, method: 'POST', body }), /durable write failed/);
  assert.deepEqual({ fetches, signs }, { fetches: 1, signs: 1 });
});

test('Marketplace rejects malformed wrapped intent and unknown gateway before signing', async () => {
  const listingId = 'echo1234';
  const callUrl = `https://x402-staging.voidly.ai/v1/services/${listingId}/call`;
  const quoteId = `0x${'a'.repeat(64)}`;
  const quoteUrl = `${callUrl}?quote=${quoteId}`;
  const body = { prompt: 'echo' };
  const intent = {
    version: 1, listingId, listingVersion: 4, quoteId, resource: quoteUrl,
    inputDigest: digest(JSON.stringify(body)), sellerWallet: PAYEE, amountAtomic: '10000',
  };
  let fetches = 0;
  let signs = 0;
  const signer = {
    address: PAYER,
    async signTypedData() { signs++; return `0x${'11'.repeat(64)}1b` as `0x${string}`; },
  };
  for (const declaration of [
    { schema: {} },
    { info: intent, schema: {}, listingId: 'conflicting-top-level' },
    { info: { ...intent, quoteId: `0x${'b'.repeat(64)}` }, schema: {} },
  ]) {
    const required = challenge('10000', quoteUrl);
    required.accepts[0]!.extra = { ...required.accepts[0]!.extra,
      assetTransferMethod: 'eip3009', paymentFlow: 'upfront' };
    required.extensions = { 'voidpay.intent': declaration };
    const fetcher: typeof fetch = async () => {
      fetches++;
      return new Response('{}', { status: 402,
        headers: { 'payment-required': encodePaymentRequiredHeader(required) } });
    };
    const wallet = AgentWallet.fromSigner(signer, {
      network: 'base-sepolia', limits: { perCallUsd: '0.02', dailyUsd: '0.03' },
      spendStore: new MemorySpendStore(), marketplaceAttemptStore: new MemoryMarketplaceAttemptStore(),
      unsafeAllowVolatileSpendStoreForTests: true, fetcher,
    });
    await assert.rejects(wallet.payX402({ url: callUrl, method: 'POST', body }), /quote binding/);
  }
  assert.deepEqual({ fetches, signs }, { fetches: 3, signs: 0 });
  const options = { limits: { perCallUsd: '0.02', dailyUsd: '0.03' },
    spendStore: new MemorySpendStore(), marketplaceAttemptStore: new MemoryMarketplaceAttemptStore(),
    unsafeAllowVolatileSpendStoreForTests: true,
    fetcher: (async () => { throw new Error('Unexpected gateway fetch'); }) as typeof fetch };
  await assert.rejects(AgentWallet.fromSigner(signer, { ...options, network: 'base-sepolia',
    allowedOrigins: ['https://x402-other.voidly.ai'] })
    .payX402({ url: `https://x402-other.voidly.ai/v1/services/${listingId}/call`, method: 'POST', body }),
  /Unsupported marketplace origin/);
  await assert.rejects(AgentWallet.fromSigner(signer, { ...options, network: 'base',
    allowedOrigins: ['https://x402-staging.voidly.ai'] })
    .payX402({ url: callUrl, method: 'POST', body }), /staging requires Base Sepolia/);
  assert.equal(signs, 0);
});

test('Marketplace CLI listing pin rejects changed version or seller before signing', async () => {
  const listingId = 'echo1234';
  const callUrl = `https://x402-staging.voidly.ai/v1/services/${listingId}/call`;
  const quoteId = `0x${'a'.repeat(64)}`;
  const quoteUrl = `${callUrl}?quote=${quoteId}`;
  const body = { prompt: 'echo' };
  const required = challenge('10000', quoteUrl);
  required.accepts[0]!.extra = { ...required.accepts[0]!.extra,
    assetTransferMethod: 'eip3009', paymentFlow: 'upfront' };
  required.extensions = { 'voidpay.intent': {
    version: 1, listingId, listingVersion: 4, quoteId, resource: quoteUrl,
    inputDigest: digest(JSON.stringify(body)), sellerWallet: PAYEE, amountAtomic: '10000',
  } };
  let fetches = 0;
  let signs = 0;
  const wallet = AgentWallet.fromSigner({ address: PAYER,
    async signTypedData() { signs++; return `0x${'11'.repeat(64)}1b` as `0x${string}`; },
  }, {
    network: 'base-sepolia', limits: { perCallUsd: '0.02', dailyUsd: '0.03' },
    spendStore: new MemorySpendStore(), marketplaceAttemptStore: new MemoryMarketplaceAttemptStore(),
    unsafeAllowVolatileSpendStoreForTests: true,
    fetcher: async () => { fetches++;
      return new Response('{}', { status: 402,
        headers: { 'payment-required': encodePaymentRequiredHeader(required) } }); },
  });
  for (const expectedMarketplace of [
    { listingId, version: 5, payTo: PAYEE },
    { listingId, version: 4, payTo: '0x3333333333333333333333333333333333333333' as const },
  ]) {
    await assert.rejects(wallet.payX402({ url: callUrl, method: 'POST', body,
      expectedMarketplace }), /selected listing version or seller/);
  }
  assert.deepEqual({ fetches, signs }, { fetches: 2, signs: 0 });
  await assert.rejects(wallet.payX402({ url: callUrl, method: 'POST', body,
    expectedMarketplace: { listingId: 'different', version: 4, payTo: PAYEE } }),
  /Invalid expected Marketplace listing/);
  assert.equal(fetches, 2);
});

test('per-call cap and quote/asset mismatch refuse before inert signer runs', async () => {
  for (const bad of [
    challenge('30000'),
    challenge('10000', 'https://other.example.test/v1/services/echo/call'),
    challenge('10000', QUOTE_URL, '0x3333333333333333333333333333333333333333'),
  ]) {
    const mock = fixture(bad);
    const wallet = AgentWallet.fromSigner(mock.signer, {
      network: 'base-sepolia',
      limits: { perCallUsd: '0.02', dailyUsd: '0.10' },
      spendStore: new MemorySpendStore(),
      unsafeAllowVolatileSpendStoreForTests: true,
      allowedOrigins: ['https://x402.example.test'],
      fetcher: mock.fetcher,
    });
    await assert.rejects(wallet.payX402({ url: CALL_URL, method: 'POST', body: { prompt: 'echo' } }));
    assert.equal(mock.counts().signs, 0);
    assert.equal(mock.counts().fetches, 1);
  }
});

test('invalid or oversized authorization lifetime refuses before inert signer runs', async () => {
  for (const timeout of [0, 121]) {
    const quote = challenge('10000');
    quote.accepts[0]!.maxTimeoutSeconds = timeout;
    const mock = fixture(quote);
    const wallet = AgentWallet.fromSigner(mock.signer, {
      network: 'base-sepolia', limits: { perCallUsd: '0.02', dailyUsd: '0.10' },
      maxAuthorizationSeconds: 120,
      spendStore: new MemorySpendStore(), unsafeAllowVolatileSpendStoreForTests: true,
      allowedOrigins: ['https://x402.example.test'],
      fetcher: mock.fetcher,
    });
    await assert.rejects(wallet.payX402({ url: CALL_URL, method: 'POST', body: { prompt: 'echo' } }), /authorization lifetime/);
    assert.equal(mock.counts().signs, 0);
    assert.equal(mock.counts().fetches, 1);
  }
});

test('payment URL and missing durable store fail before any fetch', async () => {
  let fetches = 0;
  const wallet = AgentWallet.fromSigner({ address: PAYER, async signTypedData() { throw new Error('must not sign'); } }, {
    network: 'base-sepolia', limits: { perCallUsd: '1', dailyUsd: '5' },
    fetcher: async () => { fetches++; throw new Error('must not fetch'); },
  });
  await assert.rejects(wallet.payX402({ url: CALL_URL }), /durable spend store/);
  assert.equal(fetches, 0);
  const another = AgentWallet.fromSigner({ address: PAYER, async signTypedData() { throw new Error('must not sign'); } }, {
    network: 'base-sepolia', limits: { perCallUsd: '1', dailyUsd: '5' }, spendStore: new MemorySpendStore(),
    fetcher: async () => { fetches++; throw new Error('must not fetch'); },
  });
  await assert.rejects(another.payX402({ url: CALL_URL }), /Volatile spend store refused/);
  assert.equal(fetches, 0);
  const testOnly = AgentWallet.fromSigner({ address: PAYER, async signTypedData() { throw new Error('must not sign'); } }, {
    network: 'base-sepolia', limits: { perCallUsd: '1', dailyUsd: '5' }, spendStore: new MemorySpendStore(),
    unsafeAllowVolatileSpendStoreForTests: true,
    fetcher: async () => { fetches++; throw new Error('must not fetch'); },
  });
  await assert.rejects(testOnly.payX402({ url: 'http://127.0.0.1/call' }), /public HTTPS/);
  for (const host of ['192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1']) {
    await assert.rejects(testOnly.payX402({ url: `https://${host}/call` }), /not public/);
  }
  assert.equal(fetches, 0);
});

test('mainnet requires an explicit origin and a wallet key stays out of object inspection', async () => {
  const privateKey = `0x${'09'.repeat(32)}` as `0x${string}`;
  const limits = { perCallUsd: '0.02', dailyUsd: '0.03' };
  assert.throws(() => AgentWallet.fromPrivateKey(privateKey, { network: 'base', limits }),
    /explicit payment origin allowlist/);
  const wallet = AgentWallet.fromPrivateKey(privateKey, {
    network: 'base', limits, allowedOrigins: ['https://x402.voidly.ai'],
  });
  assert.ok(!inspect(wallet, { showHidden: true, depth: 5 }).includes(privateKey));
  const sepolia = AgentWallet.fromPrivateKey(privateKey, {
    network: 'base-sepolia', limits, spendStore: new MemorySpendStore(),
    unsafeAllowVolatileSpendStoreForTests: true,
  });
  await assert.rejects(sepolia.payX402({ url: CALL_URL }), /Payment origin is not allowed/);
});

test('new wallet backups require the generated 32-byte recovery-secret format', async () => {
  const privateKey = `0x${'07'.repeat(32)}` as `0x${string}`;
  const secret = generateRecoverySecret();
  assert.equal(isGeneratedRecoverySecret(secret), true);
  assert.equal(Buffer.from(secret.slice('voidly-rs-v1-'.length), 'base64url').length, 32);
  assert.equal(isGeneratedRecoverySecret('human-picked-long-passphrase-0000'), false);
  await assert.rejects(encryptWalletBackup(privateKey, 'human-picked-long-passphrase-0000'),
    /generated 32-byte recovery secret/);
  assert.equal(await decryptWalletBackup(await encryptWalletBackup(privateKey, secret), secret), privateKey);
});

test('file budget survives a new process instance and serializes simultaneous reservations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'voidly-wallet-spend-'));
  try {
    const first = new FileSpendStore(dir);
    const second = new FileSpendStore(dir);
    const request = { wallet: PAYER, network: 'base-sepolia' as const, amountAtomic: 20_000n, dailyLimitAtomic: 30_000n };
    await first.initialize(PAYER, 'base-sepolia');
    const results = await Promise.allSettled([first.reserve(request), second.reserve(request)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    const contents = JSON.parse(await readFile(join(dir, `${PAYER.toLowerCase()}-base-sepolia.json`), 'utf8'));
    assert.equal(contents.reservedAtomic, '20000');
    await assert.rejects(second.reserve(request), /Daily USDC authorization limit exceeded/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('missing spend ledger fails closed and recovered wallet waits until next UTC day', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'voidly-wallet-recovered-'));
  try {
    const ledger = new FileSpendStore(dir);
    const now = new Date('2026-10-06T12:00:00.000Z');
    const request = { wallet: PAYER, network: 'base-sepolia' as const,
      amountAtomic: 1n, dailyLimitAtomic: 10n, now };
    await assert.rejects(ledger.reserve(request), /Spend ledger missing/);
    await ledger.initialize(PAYER, 'base-sepolia', true, now);
    await assert.rejects(ledger.reserve(request), /paused until the next UTC day/);
    const next = await ledger.reserve({ ...request, now: new Date('2026-10-07T00:00:00.000Z') });
    assert.equal(next.reservedAtomic, 1n);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('paid request redirects are returned without following or forwarding payment header', async () => {
  let requests = 0;
  const signer = { address: PAYER, async signTypedData() { return `0x${'11'.repeat(64)}1b` as `0x${string}`; } };
  const fetcher: typeof fetch = async (input, init) => {
    requests++;
    assert.equal(init?.redirect, 'manual');
    const request = new Request(input);
    assert.equal(request.url, CALL_URL);
    if (requests === 1) return new Response('{}', { status: 402, headers: { 'payment-required': encodePaymentRequiredHeader(challenge('10000')) } });
    return new Response(null, { status: 302, headers: { location: 'https://other.example.test/collect' } });
  };
  const wallet = AgentWallet.fromSigner(signer, {
    network: 'base-sepolia', limits: { perCallUsd: '1', dailyUsd: '5' },
    spendStore: new MemorySpendStore(), fetcher,
    unsafeAllowVolatileSpendStoreForTests: true,
    allowedOrigins: ['https://x402.example.test'],
  });
  const response = await wallet.payX402({ url: CALL_URL });
  assert.equal(response.status, 302);
  assert.equal(requests, 2);
});

test('synthetic key backup is NaCl ciphertext; Relay sees no key or recovery secret', async () => {
  const syntheticKey = `0x${'01'.repeat(32)}` as `0x${string}`;
  const secret = syntheticRecoverySecret(1);
  const envelope = await encryptWalletBackup(syntheticKey, secret);
  assert.equal(await decryptWalletBackup(envelope, secret), syntheticKey);
  await assert.rejects(decryptWalletBackup(envelope, 'wrong-agent-held-secret-0002'), /Wrong recovery secret/);
  const damaged: EncryptedWalletBackup = { ...envelope, ciphertext: Buffer.from('tampered').toString('base64') };
  await assert.rejects(decryptWalletBackup(damaged, secret));

  const values = new Map<string, { value: string; value_type: string }>();
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(new Headers(init?.headers).get('X-Agent-Key'), 'synthetic-relay-auth');
    if (url.pathname === '/v1/agent/memory/agent-wallet') {
      assert.equal(url.searchParams.get('limit'), '500');
      return Response.json({ keys: [...values.keys()].map(key => ({ key })), has_more: false });
    }
    assert.match(url.pathname, /^\/v1\/agent\/memory\/agent-wallet\/0x[0-9a-f]{40}\.[0-9a-f]{32}$/);
    const key = url.pathname.split('/').at(-1)!;
    if (init?.method === 'PUT') {
      const stored = String(init.body);
      assert.ok(!stored.includes(syntheticKey));
      assert.ok(!stored.includes(secret));
      const body = JSON.parse(stored) as { value: string; value_type: string };
      assert.equal(body.value_type, 'client-encrypted:agent-wallet-v1');
      values.set(key, body);
      return Response.json({ stored: true });
    }
    const value = values.get(key);
    return value ? Response.json(value) : new Response(null, { status: 404 });
  };
  const wallet = AgentWallet.fromPrivateKey(syntheticKey, {
    network: 'base-sepolia', limits: { perCallUsd: '1', dailyUsd: '5' },
  });
  const relay = new RelayWalletBackupStore('https://api.voidly.ai/', 'synthetic-relay-auth', wallet.address, fetcher);
  await wallet.backupToStore(secret, relay);
  assert.deepEqual(await RelayWalletBackupStore.listWalletAddresses('https://api.voidly.ai/', 'synthetic-relay-auth', fetcher), [wallet.address.toLowerCase()]);
  const recovered = await AgentWallet.restoreFromStore(secret, relay, {
    network: 'base-sepolia', limits: { perCallUsd: '1', dailyUsd: '5' },
  });
  assert.equal(recovered.address, wallet.address);

  const second = AgentWallet.fromPrivateKey(`0x${'02'.repeat(32)}`, {
    network: 'base-sepolia', limits: { perCallUsd: '1', dailyUsd: '5' },
  });
  const secondRelay = new RelayWalletBackupStore('https://api.voidly.ai/', 'synthetic-relay-auth', second.address, fetcher);
  await second.backupToStore(secret, secondRelay);
  assert.equal(values.size, 2);
  await assert.rejects(second.backupToStore(secret, relay), /address does not match wallet/);
  await assert.rejects(wallet.backupToStore(syntheticRecoverySecret(5), relay), /already exists/);
  const alternateRelay = new RelayWalletBackupStore('https://api.voidly.ai/', 'synthetic-relay-auth', wallet.address, fetcher);
  await wallet.backupToStore(syntheticRecoverySecret(5), alternateRelay);
  assert.notEqual(alternateRelay.backupKey, relay.backupKey);
  assert.equal(values.size, 3);
  assert.equal((await AgentWallet.restoreFromStore(secret, relay, {
    network: 'base-sepolia', limits: { perCallUsd: '1', dailyUsd: '5' },
  })).address, wallet.address);
  assert.equal((await AgentWallet.restoreFromStore(syntheticRecoverySecret(5), alternateRelay, {
    network: 'base-sepolia', limits: { perCallUsd: '1', dailyUsd: '5' },
  })).address, wallet.address);
});

test('local encrypted vault refuses accidental overwrite and restores with one secret', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'voidly-wallet-vault-'));
  try {
    const syntheticKey = `0x${'02'.repeat(32)}` as `0x${string}`;
    const secret = syntheticRecoverySecret(3);
    const vault = new LocalWalletBackupStore(dir);
    const wallet = AgentWallet.fromPrivateKey(syntheticKey, {
      network: 'base-sepolia', limits: { perCallUsd: '1', dailyUsd: '5' },
    });
    await wallet.backupToStore(secret, vault);
    const raw = await readFile(join(dir, 'wallet-backup-v1.json'), 'utf8');
    assert.ok(!raw.includes(syntheticKey));
    assert.ok(!raw.includes(secret));
    await assert.rejects(wallet.backupToStore(secret, vault), { code: 'EEXIST' });
    const recovered = await AgentWallet.restoreFromStore(secret, vault, {
      network: 'base-sepolia', limits: { perCallUsd: '1', dailyUsd: '5' },
    });
    assert.equal(recovered.address, wallet.address);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('receive address and injected balance do not need a provider', async () => {
  const wallet = AgentWallet.fromSigner({ address: PAYER, async signTypedData() { throw new Error('not called'); } }, {
    network: 'base-sepolia', limits: { perCallUsd: '1', dailyUsd: '5' },
    balanceReader: async () => 123_456n,
  });
  assert.deepEqual(wallet.receiveInfo(), { address: PAYER, network: 'base-sepolia', chainId: 84532, asset: 'USDC', tokenAddress: USDC });
  assert.deepEqual(await wallet.balance(), { address: PAYER, network: 'base-sepolia', usdcAtomic: '123456', usdc: '0.123456' });
});

test('funding request uses exact Base USDC EIP-681 bytes and a local QR', async () => {
  let signs = 0;
  let fetches = 0;
  const signer = { address: PAYER, async signTypedData() { signs++; throw new Error('must not sign'); } };
  const fetcher: typeof fetch = async () => { fetches++; throw new Error('must not fetch'); };
  const mainnet = AgentWallet.fromSigner(signer, {
    network: 'base', limits: { perCallUsd: '1', dailyUsd: '5' },
    allowedOrigins: ['https://x402.voidly.ai'], fetcher,
  });
  const funded = await mainnet.fundingRequest({ amountUsdc: '1.25', expectedChainId: 8453 });
  const mainnetToken = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  assert.deepEqual({ ...funded, qrSvg: undefined }, {
    address: PAYER, network: 'base', chainId: 8453, asset: 'USDC',
    tokenAddress: mainnetToken, amountUsdc: '1.25', amountAtomic: '1250000',
    uri: `ethereum:${mainnetToken}@8453/transfer?address=${PAYER}&uint256=1250000`,
    qrSvg: undefined,
  });
  assert.match(funded.qrSvg, /^<svg\b[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(funded.qrSvg, /<path\b/);
  assert.ok(!funded.qrSvg.includes('privateKey'));
  assert.deepEqual({ signs, fetches }, { signs: 0, fetches: 0 });
});

test('amountless Base Sepolia request retains USDC transfer and rejects wrong chain or amount', async () => {
  const wallet = AgentWallet.fromSigner({ address: PAYER, async signTypedData() { throw new Error('must not sign'); } }, {
    network: 'base-sepolia', limits: { perCallUsd: '1', dailyUsd: '5' },
  });
  const request = await wallet.fundingRequest({ expectedChainId: 84532 });
  const sepoliaToken = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
  assert.deepEqual({ ...request, qrSvg: undefined }, {
    address: PAYER, network: 'base-sepolia', chainId: 84532, asset: 'USDC',
    tokenAddress: sepoliaToken, amountUsdc: null, amountAtomic: null,
    uri: `ethereum:${sepoliaToken}@84532/transfer?address=${PAYER}`,
    qrSvg: undefined,
  });
  assert.match(request.qrSvg, /<path\b/);
  assert.notEqual(request.qrSvg, (await wallet.fundingRequest({ amountUsdc: '1' })).qrSvg);
  await assert.rejects(wallet.fundingRequest({ expectedChainId: 8453 }), /chain/i);
  await assert.rejects(wallet.fundingRequest({ expectedChainId: 1 }), /chain/i);
  for (const amountUsdc of ['0', '-1', '1.0000001', '1e3', ' 1']) {
    await assert.rejects(wallet.fundingRequest({ amountUsdc }), /amount|USDC/i);
  }
});

test('funding wallet refuses unsupported runtime chains, including inherited property names', () => {
  const signer = { address: PAYER, async signTypedData() { throw new Error('must not sign'); } };
  for (const network of ['ethereum', '__proto__']) {
    assert.throws(() => AgentWallet.fromSigner(signer, {
      network: network as 'base', limits: { perCallUsd: '1', dailyUsd: '5' },
      allowedOrigins: ['https://x402.voidly.ai'],
    }), /Unsupported Base network/);
  }
});
