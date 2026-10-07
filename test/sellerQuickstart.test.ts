import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { recoverMessageAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { runWalletCli, SellerQuickstartExistingIntentError,
  SellerQuickstartUncertainError } from '../src/cli.js';
import { AgentWallet, validateVoidlySellerListingInput,
  type VoidlySellerListingInput, type VoidlySellerQuickstartInput } from '../src/index.js';

const ORIGIN = 'https://x402-staging.voidly.ai';
const KEY = `0x${'09'.repeat(32)}` as `0x${string}`;
const ACCOUNT = privateKeyToAccount(KEY);
const ADDRESS = ACCOUNT.address;
const DID = 'did:voidly:3MNQE1';
const LISTING_ID = `svc_${'a'.repeat(32)}`;
const HMAC_SECRET = 'ab'.repeat(32);
const IDEMPOTENCY_KEY = 'synthetic_quickstart_key_001';
const NONCE = '0123456789abcdef0123456789abcdef';
const STATEMENT = 'Authorize one Voidly marketplace mutation. This does not transfer funds.';

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

async function fixture() {
  // Keep these small private fixtures as task evidence; do not remove another lane's files.
  const root = await mkdtemp(join(await realpath(tmpdir()), 'voidly-wallet-quickstart-'));
  const listingPath = join(root, 'listing.json');
  const secretDirectory = join(root, 'seller-secrets');
  const secretPath = join(secretDirectory, 'quickstart-secret.json');
  const listing = listingInput();
  await mkdir(secretDirectory, { mode: 0o700 });
  await writeFile(listingPath, JSON.stringify(listing), { mode: 0o600 });
  return { root, listingPath, secretPath, listing };
}

async function intentFiles(root: string): Promise<Array<{ path: string; value: Record<string, unknown> }>> {
  const found: Array<{ path: string; value: Record<string, unknown> }> = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { await visit(path); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
        if (typeof value.idempotencyKey === 'string' ||
            value.payload && typeof value.payload === 'object' &&
            typeof (value.payload as Record<string, unknown>).idempotencyKey === 'string') {
          found.push({ path, value });
        }
      } catch { /* Other small fixtures are not intent records. */ }
    }
  }
  await visit(root);
  return found;
}

function quickstartResponse(listing: VoidlySellerListingInput, health: {
  healthState: string; healthCheckedAt: number | null; healthFailureCode: string | null;
  updatedAt?: number;
} = { healthState: 'unchecked', healthCheckedAt: null, healthFailureCode: null }): Response {
  return Response.json({
    provider: { wallet: ADDRESS, chainId: 84532, status: 'active',
      sellerDailyCapAtomic: null, sellerCapVersion: 1 },
    listing: { ...listing, outputPrivacy: 'plain-json', id: LISTING_ID, version: 1,
      chainId: 84532, providerWallet: ADDRESS, status: 'pending', ...health },
    hmacSecretHex: HMAC_SECRET,
    upstreamContract: {
      url: listing.upstreamUrl,
      secretEncoding: '32-byte key, lowercase hex; HMAC-SHA256 signatures are lowercase hex',
      health: { method: 'GET', keyVersion: 1,
        requestHeaders: { 'X-Voidpay-Health-Listing': LISTING_ID } },
      paidCall: { method: 'POST' },
      activation: { path: `/v1/listings/${LISTING_ID}/activate`, action: 'listing_activate' },
    },
  }, { status: 201, headers: { 'cache-control': 'private, no-store' } });
}

function inertWallet(root: string, events: string[], prepared: VoidlySellerQuickstartInput[]): AgentWallet {
  return {
    address: ADDRESS, network: 'base-sepolia',
    async prepareVoidlySellerQuickstart(input: VoidlySellerQuickstartInput) {
      const intents = await intentFiles(root);
      assert.equal(intents.length, 1, 'private retry intent must exist before signing');
      assert.equal((await stat(intents[0]!.path)).mode & 0o077, 0);
      assert.equal(intents[0]!.value.idempotencyKey ??
        (intents[0]!.value.payload as Record<string, unknown>).idempotencyKey,
      input.idempotencyKey);
      events.push('prepare');
      prepared.push(input);
      return { submitUrl: `${ORIGIN}/v1/sellers/quickstart`,
        body: { payload: input, message: `synthetic-challenge-${prepared.length}`,
          signature: `0x${String(prepared.length).repeat(130)}` as `0x${string}` } };
    },
  } as unknown as AgentWallet;
}

function command(listingPath: string, secretPath: string, extra: string[] = [], did = DID): string[] {
  return ['sell', '--quickstart', '--network', 'base-sepolia', '--listing', listingPath,
    '--secret-file', secretPath, '--did', did, ...extra];
}

test('quickstart saves the retry intent before signing and a private secret receipt after one POST', async () => {
  const { root, listingPath, secretPath, listing } = await fixture();
  const events: string[] = [];
  const prepared: VoidlySellerQuickstartInput[] = [];
  const wallet = inertWallet(root, events, prepared);
  let posts = 0;
  const fetcher: typeof fetch = async (input, init) => {
    posts++;
    events.push('post');
    assert.equal(String(input), `${ORIGIN}/v1/sellers/quickstart`);
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'manual');
    assert.equal(init?.credentials, 'omit');
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.deepEqual(body.payload, prepared[0]);
    assert.equal(body.message, 'synthetic-challenge-1');
    assert.equal((await intentFiles(root)).length, 1);
    return quickstartResponse(listing);
  };
  const result = await runWalletCli(command(listingPath, secretPath), {
    env: { VOIDLY_WALLET_STATE_DIR: root }, fetcher, restoreWallet: async () => wallet,
  });
  assert.deepEqual(events, ['prepare', 'post']);
  assert.equal(posts, 1);
  assert.equal(prepared[0]?.did, DID);
  assert.deepEqual(prepared[0]?.listing, validateVoidlySellerListingInput(listing));
  assert.equal(result.command, 'sell');
  assert.equal(result.quickstart, true);
  assert.equal(result.status, 'pending_activation');
  assert.equal(result.listingId, LISTING_ID);
  assert.equal(result.secretFile, secretPath);
  assert.equal(typeof result.intentFile, 'string');
  assert.equal((await stat(result.intentFile as string)).mode & 0o077, 0);
  assert.equal((await stat(secretPath)).mode & 0o077, 0);
  assert.equal((await stat(join(root, 'seller-secrets'))).mode & 0o077, 0);
  assert.equal(JSON.stringify(result).includes(HMAC_SECRET), false);
  const receipt = JSON.parse(await readFile(secretPath, 'utf8')) as Record<string, unknown>;
  assert.equal(receipt.listingId, LISTING_ID);
  assert.equal(receipt.hmacSecretHex, HMAC_SECRET);
  assert.equal(receipt.gateway, ORIGIN);
});

test('uncertain quickstart keeps its intent and explicit resume uses the same key with a fresh signature', async () => {
  const { root, listingPath, secretPath, listing } = await fixture();
  const events: string[] = [];
  const prepared: VoidlySellerQuickstartInput[] = [];
  const wallet = inertWallet(root, events, prepared);
  let posts = 0;
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(String(input), `${ORIGIN}/v1/sellers/quickstart`);
    posts++;
    events.push('post');
    assert.deepEqual(JSON.parse(String(init?.body)).payload, prepared[posts - 1]);
    if (posts === 1) throw new Error('synthetic response lost after gateway commit');
    return quickstartResponse(listing);
  };
  const dependencies = { env: { VOIDLY_WALLET_STATE_DIR: root }, fetcher,
    restoreWallet: async () => wallet };
  let intentPath = '';
  await assert.rejects(runWalletCli(command(listingPath, secretPath), dependencies), error => {
    assert.equal(error instanceof SellerQuickstartUncertainError, true);
    const uncertain = error as SellerQuickstartUncertainError;
    assert.equal(uncertain.retrySameIntent, true);
    assert.equal(uncertain.secretFile, secretPath);
    intentPath = uncertain.intentFile;
    assert.equal(typeof intentPath, 'string');
    assert.equal(String(uncertain).includes(HMAC_SECRET), false);
    return true;
  });
  assert.equal(posts, 1, 'uncertain POST must not be retried automatically');
  assert.equal((await stat(intentPath)).mode & 0o077, 0);
  const key = prepared[0]!.idempotencyKey;
  assert.match(key, /^[A-Za-z0-9_-]{16,64}$/);
  const result = await runWalletCli(command(listingPath, secretPath,
    ['--resume-file', intentPath]), dependencies);
  assert.equal(result.status, 'pending_activation');
  assert.equal(result.intentFile, intentPath);
  assert.equal(posts, 2, 'exactly one POST per explicit invocation');
  assert.equal(prepared.length, 2);
  assert.deepEqual(prepared[1], prepared[0], 'resume must reuse the exact intent payload');
  assert.deepEqual(events, ['prepare', 'post', 'prepare', 'post']);
  assert.equal((await stat(intentPath)).mode & 0o077, 0);
});

test('explicit resume accepts the same pending listing after a failed health probe', async () => {
  const { root, listingPath, secretPath, listing } = await fixture();
  const prepared: VoidlySellerQuickstartInput[] = [];
  const wallet = inertWallet(root, [], prepared);
  const posted: Array<{ payload: VoidlySellerQuickstartInput; message: string; signature: string }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(String(input), `${ORIGIN}/v1/sellers/quickstart`);
    posted.push(JSON.parse(String(init?.body)) as typeof posted[number]);
    if (posted.length === 1) throw new Error('synthetic response lost after gateway commit');
    return quickstartResponse(listing, { healthState: 'failed',
      healthCheckedAt: 1_760_000_000_000, updatedAt: 1_760_000_000_000,
      healthFailureCode: 'upstream_unavailable' });
  };
  const dependencies = { env: { VOIDLY_WALLET_STATE_DIR: root }, fetcher,
    restoreWallet: async () => wallet };
  let intentPath = '';
  await assert.rejects(runWalletCli(command(listingPath, secretPath), dependencies), error => {
    assert.equal(error instanceof SellerQuickstartUncertainError, true);
    intentPath = (error as SellerQuickstartUncertainError).intentFile;
    return true;
  });
  assert.equal(posted.length, 1, 'the lost response must not trigger an automatic retry');
  const originalKey = posted[0]!.payload.idempotencyKey;
  const resumed = await runWalletCli(command(listingPath, secretPath,
    ['--resume-file', intentPath]), dependencies);
  assert.equal(resumed.status, 'pending_activation');
  assert.equal(resumed.listingId, LISTING_ID);
  assert.equal(resumed.intentFile, intentPath);
  assert.equal(resumed.secretFile, secretPath);
  assert.equal(posted.length, 2, 'only one POST per explicit invocation');
  assert.equal(prepared.length, 2);
  assert.equal(posted[1]!.payload.idempotencyKey, originalKey);
  assert.deepEqual(posted[1]!.payload, posted[0]!.payload,
    'resume must preserve the exact signed listing and idempotency key');
  assert.notEqual(posted[1]!.message, posted[0]!.message, 'resume must use a fresh challenge');
  assert.notEqual(posted[1]!.signature, posted[0]!.signature, 'resume must use a fresh signature');
  assert.equal((await intentFiles(root)).length, 1);
  assert.equal((await stat(secretPath)).mode & 0o077, 0);
  const receipt = JSON.parse(await readFile(secretPath, 'utf8')) as Record<string, unknown>;
  assert.equal(receipt.listingId, LISTING_ID);
  assert.equal(receipt.hmacSecretHex, HMAC_SECRET);
  assert.equal(JSON.stringify(resumed).includes(HMAC_SECRET), false);
});

test('malformed failed-health recovery remains uncertain and leaves the secret unwritten', async () => {
  for (const health of [
    { healthState: 'failed', healthCheckedAt: null, healthFailureCode: '' },
    { healthState: 'failed', healthCheckedAt: 1_760_000_000_000,
      updatedAt: 1_760_000_000_001, healthFailureCode: 'upstream_unavailable' },
  ]) {
    const { root, listingPath, secretPath, listing } = await fixture();
    const prepared: VoidlySellerQuickstartInput[] = [];
    const wallet = inertWallet(root, [], prepared);
    let posts = 0;
    const fetcher: typeof fetch = async () => {
      posts++;
      if (posts === 1) throw new Error('synthetic response lost after gateway commit');
      return quickstartResponse(listing, health);
    };
    const dependencies = { env: { VOIDLY_WALLET_STATE_DIR: root }, fetcher,
      restoreWallet: async () => wallet };
    let intentPath = '';
    await assert.rejects(runWalletCli(command(listingPath, secretPath), dependencies), error => {
      assert.equal(error instanceof SellerQuickstartUncertainError, true);
      intentPath = (error as SellerQuickstartUncertainError).intentFile;
      return true;
    });
    await assert.rejects(runWalletCli(command(listingPath, secretPath,
      ['--resume-file', intentPath]), dependencies), error => {
      assert.equal(error instanceof SellerQuickstartUncertainError, true);
      assert.equal((error as SellerQuickstartUncertainError).intentFile, intentPath);
      return true;
    });
    assert.equal(posts, 2);
    assert.equal(prepared[1]!.idempotencyKey, prepared[0]!.idempotencyKey);
    assert.equal((await intentFiles(root)).length, 1);
    await assert.rejects(stat(secretPath), { code: 'ENOENT' });
  }
});

test('a second fresh quickstart refuses the existing intent before another challenge or POST', async () => {
  const { root, listingPath, secretPath, listing } = await fixture();
  const prepared: VoidlySellerQuickstartInput[] = [];
  const wallet = inertWallet(root, [], prepared);
  const posted: Array<{ payload: VoidlySellerQuickstartInput; message: string }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(String(input), `${ORIGIN}/v1/sellers/quickstart`);
    posted.push(JSON.parse(String(init?.body)) as { payload: VoidlySellerQuickstartInput; message: string });
    if (posted.length === 1) throw new Error('synthetic response lost');
    return quickstartResponse(listing);
  };
  const dependencies = { env: { VOIDLY_WALLET_STATE_DIR: root }, fetcher,
    restoreWallet: async () => wallet };
  let originalIntent = '';
  await assert.rejects(runWalletCli(command(listingPath, secretPath), dependencies), error => {
    assert.equal(error instanceof SellerQuickstartUncertainError, true);
    originalIntent = (error as SellerQuickstartUncertainError).intentFile;
    return true;
  });
  assert.equal(prepared.length, 1);
  assert.equal(posted.length, 1);
  const originalKey = prepared[0]!.idempotencyKey;

  await assert.rejects(runWalletCli(command(listingPath, secretPath), dependencies), error => {
    assert.equal(error instanceof SellerQuickstartExistingIntentError, true);
    const existing = error as SellerQuickstartExistingIntentError;
    assert.equal(existing.intentFile, originalIntent);
    assert.equal(existing.retrySameIntent, true);
    return true;
  });
  assert.equal(prepared.length, 1, 'a fresh call must not request another signed challenge');
  assert.equal(posted.length, 1, 'a fresh call must not submit with a second key');
  assert.equal((await intentFiles(root)).length, 1);

  await assert.rejects(runWalletCli(command(listingPath, secretPath, [], 'did:voidly:4MNQE2'),
    dependencies), error => {
    assert.equal(error instanceof SellerQuickstartExistingIntentError, true);
    assert.equal((error as SellerQuickstartExistingIntentError).intentFile, originalIntent);
    return true;
  });
  assert.equal(prepared.length, 1, 'changing DID must not allocate another key for the listing');
  assert.equal(posted.length, 1);

  const resumed = await runWalletCli(command(listingPath, secretPath,
    ['--resume-file', originalIntent]), dependencies);
  assert.equal(resumed.status, 'pending_activation');
  assert.equal(resumed.intentFile, originalIntent);
  assert.equal(prepared.length, 2);
  assert.equal(posted.length, 2);
  assert.equal(prepared[1]!.idempotencyKey, originalKey);
  assert.deepEqual(posted[1]!.payload, posted[0]!.payload);
  assert.notEqual(posted[1]!.message, posted[0]!.message, 'resume must use a fresh challenge');
});

test('explicit resume preserves an empty or partial secret file and writes a new private receipt', async () => {
  for (const partial of ['', '{"version":1,']) {
    const { root, listingPath, secretPath, listing } = await fixture();
    const prepared: VoidlySellerQuickstartInput[] = [];
    const wallet = inertWallet(root, [], prepared);
    const posted: Array<{ payload: VoidlySellerQuickstartInput; message: string }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      assert.equal(String(input), `${ORIGIN}/v1/sellers/quickstart`);
      posted.push(JSON.parse(String(init?.body)) as { payload: VoidlySellerQuickstartInput; message: string });
      if (posted.length === 1) throw new Error('synthetic response lost after gateway commit');
      return quickstartResponse(listing);
    };
    const dependencies = { env: { VOIDLY_WALLET_STATE_DIR: root }, fetcher,
      restoreWallet: async () => wallet };
    let intentPath = '';
    await assert.rejects(runWalletCli(command(listingPath, secretPath), dependencies), error => {
      assert.equal(error instanceof SellerQuickstartUncertainError, true);
      intentPath = (error as SellerQuickstartUncertainError).intentFile;
      return true;
    });
    assert.equal(posted.length, 1);
    assert.equal(prepared.length, 1);
    await writeFile(secretPath, partial, { flag: 'wx', mode: 0o600 });

    const recovered = await runWalletCli(command(listingPath, secretPath,
      ['--resume-file', intentPath]), dependencies);
    assert.equal(recovered.status, 'pending_activation');
    assert.equal(recovered.intentFile, intentPath);
    assert.equal(recovered.listingId, LISTING_ID);
    assert.equal(recovered.secretFile, `${secretPath}.recovery-01.json`,
      'the first unused recovery path should hold the credential');
    assert.equal(await readFile(secretPath, 'utf8'), partial);
    assert.equal((await stat(secretPath)).mode & 0o077, 0);
    assert.equal((await stat(recovered.secretFile as string)).mode & 0o077, 0);
    const receipt = JSON.parse(await readFile(recovered.secretFile as string, 'utf8')) as Record<string, unknown>;
    assert.equal(receipt.hmacSecretHex, HMAC_SECRET);
    assert.equal(receipt.listingId, LISTING_ID);
    assert.equal(JSON.stringify(recovered).includes(HMAC_SECRET), false);
    assert.equal(posted.length, 2, 'only one POST per explicit invocation');
    assert.equal(prepared.length, 2);
    assert.deepEqual(posted[1]!.payload, posted[0]!.payload);
    assert.equal(prepared[1]!.idempotencyKey, prepared[0]!.idempotencyKey);
    assert.notEqual(posted[1]!.message, posted[0]!.message, 'resume signs a fresh challenge');

    const repeated = await runWalletCli(command(listingPath, secretPath,
      ['--resume-file', intentPath]), dependencies);
    assert.equal(repeated.secretFile, recovered.secretFile);
    assert.equal(posted.length, 2, 'a valid recovered receipt should not trigger another POST');
    assert.equal(await readFile(secretPath, 'utf8'), partial);
  }
});

test('resume mismatches fail before signing or network', async () => {
  const { root, listingPath, secretPath, listing } = await fixture();
  const prepared: VoidlySellerQuickstartInput[] = [];
  const wallet = inertWallet(root, [], prepared);
  let posts = 0;
  const fetcher: typeof fetch = async () => { posts++; throw new Error('synthetic response lost'); };
  const dependencies = { env: { VOIDLY_WALLET_STATE_DIR: root }, fetcher,
    restoreWallet: async () => wallet };
  let intentPath = '';
  await assert.rejects(runWalletCli(command(listingPath, secretPath), dependencies), error => {
    intentPath = (error as SellerQuickstartUncertainError).intentFile;
    return error instanceof SellerQuickstartUncertainError;
  });
  assert.equal(posts, 1);
  const before = prepared.length;
  await writeFile(listingPath, JSON.stringify({ ...listing, priceAtomic: listing.priceAtomic + 1 }));
  await assert.rejects(runWalletCli(command(listingPath, secretPath,
    ['--resume-file', intentPath]), dependencies), /mismatch|different|intent/i);
  assert.equal(prepared.length, before);
  assert.equal(posts, 1);
  await writeFile(listingPath, JSON.stringify(listing));
  await assert.rejects(runWalletCli(command(listingPath, join(root, 'seller-secrets', 'other.json'),
    ['--resume-file', intentPath]), dependencies), /mismatch|different|intent/i);
  assert.equal(prepared.length, before);
  assert.equal(posts, 1);
  await assert.rejects(runWalletCli(command(listingPath, secretPath,
    ['--resume-file', intentPath], 'did:voidly:4MNQE2'), dependencies),
  /mismatch|different|intent/i);
  assert.equal(prepared.length, before);
  assert.equal(posts, 1);
});

test('quickstart refuses an existing receipt target without replacing it or contacting the gateway', async () => {
  const { root, listingPath, secretPath } = await fixture();
  await writeFile(secretPath, 'preexisting private state', { mode: 0o600 });
  const prepared: VoidlySellerQuickstartInput[] = [];
  let posts = 0;
  await assert.rejects(runWalletCli(command(listingPath, secretPath), {
    env: { VOIDLY_WALLET_STATE_DIR: root },
    fetcher: async () => { posts++; throw new Error('must not contact gateway'); },
    restoreWallet: async () => inertWallet(root, [], prepared),
  }), /exist|secret|file/i);
  assert.equal(prepared.length, 0);
  assert.equal(posts, 0);
  assert.equal(await readFile(secretPath, 'utf8'), 'preexisting private state');
});

test('quickstart dry run validates listing without wallet, signing, network, or intent files', async () => {
  const { root, listingPath, secretPath } = await fixture();
  const dependencies = {
    env: { VOIDLY_WALLET_STATE_DIR: root },
    fetcher: async () => { throw new Error('dry run must not fetch'); },
    restoreWallet: async () => { throw new Error('dry run must not restore'); },
  };
  const result = await runWalletCli(command(listingPath, secretPath, ['--dry-run']), dependencies);
  assert.equal(result.command, 'sell');
  assert.equal(result.quickstart, true);
  assert.equal(result.status, 'ready');
  assert.equal((await intentFiles(root)).length, 0);
  await assert.rejects(stat(secretPath), { code: 'ENOENT' });
  await assert.rejects(runWalletCli(command(listingPath, secretPath, ['--dry-run'], 'invalid-did'),
    dependencies), /Invalid seller DID/);
});

function digest(text: string): `0x${string}` {
  return `0x${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function siweFixture(resource: string, did: string): { challenge: {
  message: string; nonce: string; expiresAt: string } } {
  const issuedAt = new Date();
  const expirationTime = new Date(issuedAt.getTime() + 300_000);
  return { challenge: { message: createSiweMessage({
    scheme: 'https', domain: 'x402-staging.voidly.ai', uri: `${ORIGIN}/v1/providers/challenge`,
    address: ADDRESS.toLowerCase() as `0x${string}`, chainId: 84532,
    version: '1', nonce: NONCE, issuedAt, expirationTime, statement: STATEMENT,
    resources: [resource, did],
  }), nonce: NONCE, expiresAt: expirationTime.toISOString() } };
}

test('SDK signs only the exact seller_quickstart SIWE resource and fixed submit target', async () => {
  const input: VoidlySellerQuickstartInput = {
    idempotencyKey: IDEMPOTENCY_KEY, listing: listingInput(), did: DID,
  };
  // The gateway hashes sorted-key JSON, then binds action, method, path, and payload digest.
  const canonicalListing = validateVoidlySellerListingInput(input.listing);
  const canonicalPayload = JSON.stringify({ did: DID, idempotencyKey: IDEMPOTENCY_KEY,
    listing: canonicalListing });
  const resource = `urn:voidly:marketplace:mutation:v1:seller_quickstart:none:${digest(JSON.stringify([
    'voidly-marketplace-mutation-v1', 'seller_quickstart', '', 'POST',
    '/v1/sellers/quickstart', digest(canonicalPayload),
  ])).slice(2)}`;
  let fetches = 0;
  let signs = 0;
  const signer = { ...ACCOUNT, async signMessage(args: { message: string }) {
    signs++;
    return ACCOUNT.signMessage(args);
  } };
  const fetcher: typeof fetch = async (url, init) => {
    fetches++;
    assert.equal(String(url), `${ORIGIN}/v1/providers/challenge`);
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), {
      wallet: ADDRESS, action: 'seller_quickstart',
      payload: { idempotencyKey: IDEMPOTENCY_KEY, listing: canonicalListing, did: DID },
    });
    return Response.json(siweFixture(resource, DID));
  };
  const wallet = AgentWallet.fromSigner(signer, { network: 'base-sepolia',
    limits: { perCallUsd: '1', dailyUsd: '5' }, allowedOrigins: [ORIGIN], fetcher });
  const prepared = await wallet.prepareVoidlySellerQuickstart(input);
  assert.equal(prepared.submitUrl, `${ORIGIN}/v1/sellers/quickstart`);
  assert.deepEqual(prepared.body.payload, { idempotencyKey: IDEMPOTENCY_KEY,
    listing: canonicalListing, did: DID });
  assert.equal(prepared.body.message.includes(resource), true);
  assert.equal(prepared.body.message.includes(DID), true);
  assert.equal((await recoverMessageAddress({ message: prepared.body.message,
    signature: prepared.body.signature })).toLowerCase(), ADDRESS.toLowerCase());
  assert.deepEqual({ fetches, signs }, { fetches: 1, signs: 1 });

  for (const [wrongResource, wrongDid] of [
    [resource.replace('seller_quickstart', 'listing_create'), DID],
    [resource, 'did:voidly:4MNQE2'],
  ]) {
    const badFetcher: typeof fetch = async () => Response.json(siweFixture(wrongResource!, wrongDid!));
    const badWallet = AgentWallet.fromSigner(signer, { network: 'base-sepolia',
      limits: { perCallUsd: '1', dailyUsd: '5' }, allowedOrigins: [ORIGIN], fetcher: badFetcher });
    await assert.rejects(badWallet.prepareVoidlySellerQuickstart(input), /quickstart challenge is invalid/);
  }
  assert.equal(signs, 1, 'mismatched SIWE resources must not sign');
  await assert.rejects(wallet.prepareVoidlySellerQuickstart({ ...input, idempotencyKey: 'short' }),
    /payload is invalid/);
  assert.deepEqual({ fetches, signs }, { fetches: 1, signs: 1 },
    'invalid idempotency key must fail locally before fetch or signing');
});
