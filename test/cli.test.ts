import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runWalletCli, type WalletCliDependencies } from '../src/cli.js';

const ID = 'svc_e756b894c55a4026aa66dca4ca293ff5';
const QUOTE_ID = `0x${'a'.repeat(64)}`;
const PAY_TO = '0x2222222222222222222222222222222222222222';
const ORIGIN = 'https://x402-staging.voidly.ai';
const DETAIL_URL = `${ORIGIN}/v1/services/${ID}?network=eip155:84532&version=4`;
const CALL_URL = `${ORIGIN}/v1/services/${ID}/call`;

type CliWallet = Awaited<ReturnType<NonNullable<WalletCliDependencies['restoreWallet']>>>;

function inertWallet(methods: Record<string, unknown>): CliWallet {
  return { address: PAY_TO, network: 'base-sepolia', ...methods } as unknown as CliWallet;
}

function noNetwork(): typeof fetch {
  return async () => { throw new Error('Unexpected network request'); };
}

async function inputFiles(t: TestContext): Promise<{ directory: string; input: string; seller: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'voidly-wallet-cli-test-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const input = join(directory, 'input.json');
  const seller = join(directory, 'listing.json');
  await writeFile(input, JSON.stringify({ country: 'FR' }));
  await writeFile(seller, JSON.stringify({
    name: 'Example answer', description: 'Returns a short answer', category: 'data',
    upstreamUrl: 'https://seller.example.test/run', method: 'POST', priceAtomic: 10_000,
    inputSchema: { type: 'object', required: ['query'], maxProperties: 1,
      properties: { query: { type: 'string', maxLength: 64 } }, additionalProperties: false },
    outputSchema: { type: 'object', required: ['answer'], maxProperties: 1,
      properties: { answer: { type: 'string', maxLength: 256 } }, additionalProperties: false },
    tags: ['example'],
  }));
  return { directory, input, seller };
}

function buyArgs(input: string): string[] {
  return ['buy', ID, '--network', 'base-sepolia', '--version', '4', '--input', input,
    '--per-call-usdc', '0.05', '--daily-usdc', '0.50', '--max-usdc', '0.02'];
}

function listing() {
  return {
    kind: 'seller', id: ID, version: 4, status: 'live', method: 'POST',
    detailUrl: DETAIL_URL, callUrl: CALL_URL, network: 'eip155:84532',
    asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    priceUsdcAtomic: '10000', payTo: PAY_TO,
    inputSchema: { type: 'object', required: ['country'] },
  };
}

function receiptHeader(): string {
  // payX402 has already verified the signed receipt before returning a Response.
  return Buffer.from(JSON.stringify({ quoteId: QUOTE_ID })).toString('base64url');
}

test('buy and sell dry runs need neither wallet restore nor network access', async t => {
  const { directory, input, seller } = await inputFiles(t);
  let restores = 0;
  const dependencies: WalletCliDependencies = {
    env: { VOIDLY_WALLET_STATE_DIR: directory }, fetcher: noNetwork(),
    restoreWallet: async () => { restores++; throw new Error('Unexpected wallet restore'); },
  };
  const buy = await runWalletCli([...buyArgs(input), '--dry-run'], dependencies);
  assert.deepEqual({ command: buy.command, status: buy.status, listingId: buy.listingId,
    version: buy.version, detailUrl: buy.detailUrl, maxUsd: buy.maxUsd }, {
    command: 'buy', status: 'ready', listingId: ID, version: 4,
    detailUrl: DETAIL_URL, maxUsd: '0.02',
  });
  const sell = await runWalletCli(['sell', '--network', 'base-sepolia', '--listing', seller,
    '--dry-run'], dependencies);
  assert.deepEqual({ command: sell.command, status: sell.status, priceAtomic: sell.priceAtomic },
    { command: 'sell', status: 'ready', priceAtomic: 10_000 });
  assert.equal(restores, 0);
});

test('buy requires explicit valid caps before listing lookup or wallet restore', async t => {
  const { directory, input } = await inputFiles(t);
  const dependencies: WalletCliDependencies = {
    env: { VOIDLY_WALLET_STATE_DIR: directory }, fetcher: noNetwork(),
    restoreWallet: async () => { throw new Error('Unexpected wallet restore'); },
  };
  const base = buyArgs(input);
  for (const [flag, expected] of [
    ['--per-call-usdc', /--per-call-usdc is required/],
    ['--daily-usdc', /--daily-usdc is required/],
    ['--max-usdc', /--max-usdc is required/],
  ] as const) {
    const at = base.indexOf(flag);
    const args = [...base];
    args.splice(at, 2);
    await assert.rejects(runWalletCli(args, dependencies), expected);
  }
  await assert.rejects(runWalletCli([...base.slice(0, -1), '0.06'], dependencies),
    /--max-usdc must be positive and no higher/);
  await assert.rejects(runWalletCli([...base, '--max-usdc', '0.01'], dependencies),
    /repeated option/);
  await assert.rejects(runWalletCli([...base.slice(0, -1), '0.0000001'], dependencies),
    /USDC limit must be a nonnegative decimal/);
  await assert.rejects(runWalletCli([...base.slice(0, -1), '0'], dependencies),
    /--max-usdc must be positive/);
});

test('buy pins the selected seller identity and caps in its sole payX402 call', async t => {
  const { directory, input } = await inputFiles(t);
  let detailFetches = 0;
  let pays = 0;
  const dependencies: WalletCliDependencies = {
    env: { VOIDLY_WALLET_STATE_DIR: directory },
    fetcher: async (url, init) => {
      detailFetches++;
      assert.equal(String(url), DETAIL_URL);
      assert.equal(init?.method, 'GET');
      assert.equal(init?.redirect, 'manual');
      return Response.json({ version: '1', item: listing() });
    },
    restoreWallet: async options => {
      assert.equal(options.mode, 'buy');
      assert.deepEqual(options.limits, { perCallUsd: '0.05', dailyUsd: '0.50' });
      return inertWallet({ payX402: async (request: unknown) => {
        pays++;
        assert.deepEqual(request, {
          url: CALL_URL, method: 'POST', body: { country: 'FR' }, maxAmountUsd: '0.02',
          expectedMarketplace: { listingId: ID, version: 4, payTo: PAY_TO },
        });
        return new Response('{"answer":"bonjour"}', { status: 200,
          headers: { 'x-voidpay-delivery-receipt': receiptHeader() } });
      } });
    },
  };
  const result = await runWalletCli(buyArgs(input), dependencies);
  assert.equal(detailFetches, 1);
  assert.equal(pays, 1);
  assert.deepEqual({ verifiedStatus: result.verifiedStatus, refundOwed: result.refundOwed,
    quoteId: result.quoteId, bodyUtf8: result.bodyUtf8, bodyComplete: result.bodyComplete,
    doNotRepay: result.doNotRepay }, {
    verifiedStatus: 'delivered', refundOwed: false, quoteId: QUOTE_ID,
    bodyUtf8: '{"answer":"bonjour"}', bodyComplete: true, doNotRepay: true,
  });
});

test('verified refund owed and incomplete paid output retain a recovery path', async t => {
  const { directory, input } = await inputFiles(t);
  let outcome: 'refund_owed' | 'incomplete' = 'refund_owed';
  const dependencies: WalletCliDependencies = {
    env: { VOIDLY_WALLET_STATE_DIR: directory },
    fetcher: async () => Response.json({ version: '1', item: listing() }),
    restoreWallet: async () => inertWallet({ payX402: async () => outcome === 'refund_owed'
      ? new Response('{"error":"refund_owed"}', { status: 502,
        headers: { 'x-voidpay-delivery-receipt': receiptHeader() } })
      : new Response(null, { status: 200,
        headers: { 'x-voidpay-delivery-receipt': receiptHeader() } }) }),
  };
  const refunded = await runWalletCli(buyArgs(input), dependencies);
  assert.equal(refunded.verifiedStatus, 'refund_owed');
  assert.equal(refunded.refundOwed, true);
  assert.equal(refunded.quoteId, QUOTE_ID);
  assert.equal(refunded.doNotRepay, true);
  outcome = 'incomplete';
  const incomplete = await runWalletCli(buyArgs(input), dependencies);
  assert.equal(incomplete.verifiedStatus, 'delivered');
  assert.equal(incomplete.bodyComplete, false);
  assert.equal(incomplete.doNotRepay, true);
  assert.equal(incomplete.quoteId, QUOTE_ID);
  assert.equal(incomplete.recoveryCommand,
    `voidly-agent-wallet recover ${QUOTE_ID} --network base-sepolia`);
});

test('attempts and recover use the original quote without invoking buy', async t => {
  const { directory } = await inputFiles(t);
  let recovered = 0;
  let includeReceiptHeader = true;
  const dependencies: WalletCliDependencies = {
    env: { VOIDLY_WALLET_STATE_DIR: directory }, fetcher: noNetwork(),
    restoreWallet: async options => {
      assert.equal(options.mode, 'recover');
      return inertWallet({
        payX402: async () => { throw new Error('Recovery must not initiate payment'); },
        marketplaceAttempts: async () => [{ quoteId: QUOTE_ID, listingId: ID,
          listingVersion: 4, createdAt: '2026-10-06T00:00:00.000Z' }],
        recoverMarketplace: async (quoteId: string) => {
          recovered++;
          assert.equal(quoteId, QUOTE_ID);
          return { response: new Response('{"answer":"recovered"}', { status: 200,
            headers: includeReceiptHeader ? { 'x-voidpay-delivery-receipt': receiptHeader() } : {} }),
          quoteId: QUOTE_ID, verifiedStatus: 'delivered', archivePending: false };
        },
      });
    },
  };
  const attempts = await runWalletCli(['attempts', '--network', 'base-sepolia'], dependencies);
  assert.deepEqual(attempts.attempts, [{ quoteId: QUOTE_ID, listingId: ID,
    listingVersion: 4, createdAt: '2026-10-06T00:00:00.000Z' }]);
  const result = await runWalletCli(['recover', QUOTE_ID, '--network', 'base-sepolia'], dependencies);
  assert.equal(recovered, 1);
  assert.equal(result.command, 'recover');
  assert.equal(result.quoteId, QUOTE_ID);
  assert.equal(result.verifiedStatus, 'delivered');
  assert.equal(result.bodyUtf8, '{"answer":"recovered"}');
  includeReceiptHeader = false;
  const recoveredWithoutHeader = await runWalletCli(
    ['recover', QUOTE_ID, '--network', 'base-sepolia'], dependencies);
  assert.equal(recoveredWithoutHeader.quoteId, QUOTE_ID);
  await assert.rejects(runWalletCli(['recover', 'bad-id', '--network', 'base-sepolia'], dependencies),
    /Invalid Marketplace quote ID/);
  assert.equal(recovered, 2);
});
