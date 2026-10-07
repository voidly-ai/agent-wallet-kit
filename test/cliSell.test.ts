import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runWalletCli, SellerCreationUncertainError } from '../src/cli.js';
import type { AgentWallet, VoidlySellerListingInput } from '../src/index.js';

const ORIGIN = 'https://x402-staging.voidly.ai';
const ADDRESS = `0x${'12'.repeat(20)}` as `0x${string}`;
const LISTING_ID = `svc_${'a'.repeat(32)}`;
const SECRET = 'ab'.repeat(32);

function listingInput(): VoidlySellerListingInput {
  return {
    name: 'Synthetic answer', description: 'Returns a short synthetic answer', category: 'data',
    upstreamUrl: 'https://seller.example.test/run', method: 'POST', priceAtomic: 10_000,
    inputSchema: { type: 'object', properties: { query: { type: 'string', maxLength: 64 } },
      required: ['query'], additionalProperties: false, maxProperties: 1 },
    outputSchema: { type: 'object', properties: { answer: { type: 'string', maxLength: 256 } },
      required: ['answer'], additionalProperties: false, maxProperties: 1 },
    tags: ['synthetic'],
  };
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'voidly-wallet-cli-sell-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const listingPath = join(root, 'listing.json');
  const secretPath = join(root, 'seller-secrets', 'listing-secret.json');
  const payload = listingInput();
  await mkdir(join(root, 'seller-secrets'), { mode: 0o700 });
  await writeFile(listingPath, JSON.stringify(payload), { mode: 0o600 });
  return { root, listingPath, secretPath, payload };
}

function inertWallet(payload: VoidlySellerListingInput, events: string[]): AgentWallet {
  return {
    address: ADDRESS, network: 'base-sepolia',
    async prepareVoidlySellerRegistration() {
      events.push('prepare-register');
      return { submitUrl: `${ORIGIN}/v1/providers/register`,
        body: { payload: {}, message: 'synthetic-register', signature: `0x${'11'.repeat(65)}` } };
    },
    async prepareVoidlySellerListingCreate(input: VoidlySellerListingInput) {
      events.push('prepare-create');
      assert.deepEqual(input, payload);
      return { submitUrl: `${ORIGIN}/v1/listings`,
        body: { payload: input, message: 'synthetic-listing-create', signature: `0x${'22'.repeat(65)}` } };
    },
  } as unknown as AgentWallet;
}

function registrationResponse(): Response {
  return Response.json({ provider: { chainId: 84532, wallet: ADDRESS, status: 'active',
    sellerDailyCapAtomic: null, sellerCapVersion: 1 } });
}

function creationResponse(payload: VoidlySellerListingInput): Response {
  return Response.json({
    listing: { ...payload, outputPrivacy: 'plain-json', chainId: 84532, id: LISTING_ID, providerWallet: ADDRESS,
      version: 1, status: 'pending', healthState: 'unchecked' },
    hmacSecretHex: SECRET,
    health: { method: 'GET', url: payload.upstreamUrl, keyVersion: 1 },
  }, { status: 201 });
}

test('sell registers then creates one pending listing and stores the one-time secret privately', async t => {
  const { root, listingPath, secretPath, payload } = await fixture(t);
  const events: string[] = [];
  const wallet = inertWallet(payload, events);
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'manual');
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (url === `${ORIGIN}/v1/providers/register`) {
      events.push('post-register');
      assert.equal(body.message, 'synthetic-register');
      return registrationResponse();
    }
    if (url === `${ORIGIN}/v1/listings`) {
      events.push('post-create');
      assert.equal(body.message, 'synthetic-listing-create');
      assert.deepEqual(body.payload, payload);
      return creationResponse(payload);
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const result = await runWalletCli([
    'sell', '--network', 'base-sepolia', '--listing', listingPath, '--secret-file', secretPath,
  ], { env: { VOIDLY_WALLET_STATE_DIR: root }, fetcher,
    restoreWallet: async () => wallet });

  assert.deepEqual(events, ['prepare-register', 'post-register', 'prepare-create', 'post-create']);
  assert.equal(result.status, 'pending_activation');
  assert.equal(result.listingId, LISTING_ID);
  assert.equal(result.secretFile, secretPath);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.equal((await stat(secretPath)).mode & 0o077, 0);
  assert.equal((await stat(join(root, 'seller-secrets'))).mode & 0o077, 0);
  const stored = JSON.parse(await readFile(secretPath, 'utf8')) as Record<string, unknown>;
  assert.equal(stored.listingId, LISTING_ID);
  assert.equal(stored.hmacSecretHex, SECRET);
  assert.equal(stored.gateway, ORIGIN);
});

test('sell treats a lost create response as uncertain and never retries the mutation', async t => {
  const { root, listingPath, secretPath, payload } = await fixture(t);
  const events: string[] = [];
  const wallet = inertWallet(payload, events);
  let createPosts = 0;
  const fetcher: typeof fetch = async input => {
    const url = String(input);
    if (url === `${ORIGIN}/v1/providers/register`) {
      events.push('post-register');
      return registrationResponse();
    }
    if (url === `${ORIGIN}/v1/listings`) {
      events.push('post-create');
      createPosts++;
      throw new Error('synthetic lost response after submit');
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  await assert.rejects(runWalletCli([
    'sell', '--network', 'base-sepolia', '--listing', listingPath, '--secret-file', secretPath,
  ], { env: { VOIDLY_WALLET_STATE_DIR: root }, fetcher,
    restoreWallet: async () => wallet }), error => {
    assert.equal(error instanceof SellerCreationUncertainError, true);
    assert.equal((error as SellerCreationUncertainError).doNotRetry, true);
    return true;
  });
  assert.deepEqual(events, ['prepare-register', 'post-register', 'prepare-create', 'post-create']);
  assert.equal(createPosts, 1);
});
