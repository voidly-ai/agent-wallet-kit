import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import nacl from 'tweetnacl';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AgentWallet, PaymentMayHaveSettledError, type AgentWalletOptions } from '../src/index.js';
import { createWalletMcpServer, type WalletMcpDependencies } from '../src/mcp.js';

const API = 'https://api.voidly.ai';
const ORIGIN = 'https://x402-staging.voidly.ai';
const LISTING_ID = 'svc_e756b894c55a4026aa66dca4ca293ff5';
const BOUNTY_ID = '11111111-1111-4111-8111-111111111111';
const QUOTE_ID = `0x${'a'.repeat(64)}` as `0x${string}`;
const PAY_TO = '0x2222222222222222222222222222222222222222';
const IDEMPOTENCY_KEY = 'b'.repeat(32);
const OPERATION_ID = 'send_20261007_0001';
const MAIL_KEY = `vm_${'a'.repeat(64)}`;
const HOME_KEY = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
const AGENT_KEY = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(19));
const ENV: NodeJS.ProcessEnv = {
  VOIDLY_HOME_ROOT_DID: 'did:voidly:Root123',
  VOIDLY_HOME_ROOT_SIGNING_SECRET_BASE64: Buffer.from(HOME_KEY.secretKey).toString('base64'),
  VOIDLY_AGENT_DID: 'did:voidly:Agent123',
  VOIDLY_AGENT_SIGNING_SECRET_BASE64: Buffer.from(AGENT_KEY.secretKey).toString('base64'),
  VOIDLY_MAIL_AGENT_KEY: MAIL_KEY,
};
const OPTIONS: AgentWalletOptions = { network: 'base-sepolia',
  limits: { perCallUsd: '0.05', dailyUsd: '0.50' }, allowedOrigins: [ORIGIN] };

function inertWallet(methods: Record<string, unknown> = {}): AgentWallet {
  return { address: PAY_TO, network: 'base-sepolia', ...methods } as unknown as AgentWallet;
}

async function connect(t: TestContext, dependencies: WalletMcpDependencies = {}, options = OPTIONS) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createWalletMcpServer(options, { commandEnv: {},
    commandFetch: async () => { assert.fail('Unexpected transport call'); }, ...dependencies });
  const client = new Client({ name: 'mcp-parity-test', version: '0.1.0' });
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  return { result, value: JSON.parse(content[0]!.text) as Record<string, any> };
}

async function input(value: unknown) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'voidly-mcp-parity-'));
  const path = join(directory, 'input.json');
  const text = JSON.stringify(value, null, 2);
  await writeFile(path, text);
  return { directory, path, text };
}

function verifyRequest(init: RequestInit | undefined, kind: 'Home' | 'Board' | 'Job',
  method: 'GET' | 'POST', path: string, body: string | null) {
  assert.equal(init?.method, method);
  assert.equal(init?.redirect, 'manual');
  assert.equal(init?.credentials, 'omit');
  assert.equal(init?.cache, 'no-store');
  assert.equal(init?.body ?? null, method === 'GET' ? null : body);
  const headers = new Headers(init?.headers);
  const did = kind === 'Home' ? ENV.VOIDLY_HOME_ROOT_DID : ENV.VOIDLY_AGENT_DID;
  const key = kind === 'Home' ? HOME_KEY : AGENT_KEY;
  assert.equal(headers.get('x-agent-did'), did);
  const timestamp = headers.get(`x-${kind}-timestamp`)!;
  const nonce = headers.get(`x-${kind}-nonce`)!;
  assert.match(timestamp, /^\d{10}$/);
  assert.match(nonce, /^[0-9a-f]{32}$/);
  const domain = kind === 'Home' ? 'voidly-home-read-v1' :
    kind === 'Board' ? 'voidly-board-post-v1' : 'voidly-agent-job-v1';
  const digest = body === null ? [] : [createHash('sha256').update(body).digest('hex')];
  const message = [domain, method, path, did, timestamp, nonce, ...digest].join('\n');
  assert.ok(nacl.sign.detached.verify(Buffer.from(message),
    Buffer.from(headers.get(`x-${kind}-signature`)!, 'base64'), key.publicKey));
  return nonce;
}

function bounty(overrides: Record<string, unknown> = {}) {
  return { id: BOUNTY_ID, title: 'Observe a public target', instructions: 'Record the result.',
    reward_atomic: '1000000', reward_currency: 'USDC', reward_decimals: 6,
    reward_status: 'advertised_unfunded', expires_at_ms: 1_800_000_000_000,
    status: 'open', claimable: true, payable: false, paid: false,
    payout_status: 'owner_run_off', ...overrides };
}

function listing() {
  return { kind: 'seller', id: LISTING_ID, version: 4, status: 'live', method: 'POST',
    detailUrl: `${ORIGIN}/v1/services/${LISTING_ID}?network=eip155:84532&version=4`,
    callUrl: `${ORIGIN}/v1/services/${LISTING_ID}/call`, network: 'eip155:84532',
    asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', priceUsdcAtomic: '10000', payTo: PAY_TO,
    inputSchema: { type: 'object', required: ['country'] } };
}

test('MCP mutation contracts refuse missing confirmation, false confirmation, and extra fields before effects', async t => {
  const fixture = await input({ harmless: true });
  let fetches = 0;
  let signs = 0;
  const client = await connect(t, {
    commandEnv: { ...ENV, VOIDLY_WALLET_STATE_DIR: fixture.directory },
    commandFetch: async () => { fetches++; assert.fail('Unconfirmed request dispatched'); },
    initialWallet: inertWallet({
      payX402: async () => { signs++; assert.fail('Unconfirmed payment'); },
      prepareVoidlySellerQuickstart: async () => { signs++; assert.fail('Unconfirmed seller request'); },
    }),
  });
  const mutations = [
    ['wallet_sell_quickstart', { listingFile: '/nonexistent/mcp-listing.json' }],
    ['wallet_buy', { listingId: LISTING_ID, version: 4, inputFile: '/nonexistent/mcp-input.json', maxUsdc: '0.02' }],
    ['voidly_board_post', { inputFile: '/nonexistent/mcp-input.json' }],
    ['voidly_board_bid', { jobId: 'job_123', inputFile: '/nonexistent/mcp-input.json' }],
    ['voidly_board_award', { jobId: 'job_123', inputFile: '/nonexistent/mcp-input.json' }],
    ['voidly_job_create', { inputFile: '/nonexistent/mcp-input.json' }],
    ['voidly_bounty_claim', { bountyId: BOUNTY_ID, inputFile: '/nonexistent/mcp-input.json' }],
    ['voidly_bounty_submit', { bountyId: BOUNTY_ID, inputFile: '/nonexistent/mcp-input.json' }],
    ['voidly_mail_send', { inputFile: '/nonexistent/mcp-input.json' }],
  ] as const;
  for (const [name, args] of mutations) {
    for (const extra of [{}, { confirm: false }, { confirm: true, network: 'base' }]) {
      const result = await client.callTool({ name, arguments: { ...args, ...extra } });
      assert.equal(result.isError, true, name);
      assert.doesNotMatch(JSON.stringify(result.content), /ENOENT|no such file|scandir/);
    }
  }
  assert.equal(fetches, 0);
  assert.equal(signs, 0);
  assert.deepEqual(await readdir(fixture.directory), ['input.json']);
  const tools = (await client.listTools()).tools;
  for (const [name] of mutations) assert.equal(tools.find(tool => tool.name === name)?.annotations?.readOnlyHint, false, name);
  for (const name of ['voidly_home', 'voidly_jobs', 'voidly_job_show', 'voidly_bounty_list',
    'voidly_bounty_show', 'voidly_mail_inbox', 'voidly_mail_read', 'voidly_mail_status']) {
    assert.equal(tools.find(tool => tool.name === name)?.annotations?.readOnlyHint, true, name);
  }
});

test('MCP Home and jobs keep signed read paths, independent availability, and secret scrubbing', async t => {
  const calls: string[] = [];
  const snapshot = { version: 'home.me.v1', observed_at: '2026-10-07T07:00:00Z',
    home: { wallet: { state: 'unlinked' }, jobs: { state: 'unavailable', items: [] },
      privateKey: ENV.VOIDLY_HOME_ROOT_SIGNING_SECRET_BASE64 } };
  const client = await connect(t, { commandEnv: ENV, commandFetch: async (url, init) => {
    calls.push(String(url));
    if (String(url) === `${API}/v1/home/me`) {
      verifyRequest(init, 'Home', 'GET', '/v1/home/me', null);
      return Response.json(snapshot);
    }
    assert.equal(String(url), `${API}/v1/agent/jobs/job_123`);
    verifyRequest(init, 'Job', 'GET', '/v1/agent/jobs/job_123', '');
    return Response.json({ error: { code: 'jobs_stopped' } }, { status: 503 });
  } });
  const home = await call(client, 'voidly_home');
  assert.notEqual(home.result.isError, true);
  assert.deepEqual(home.value.snapshot.home.wallet, { state: 'unlinked' });
  assert.equal(home.value.snapshot.home.privateKey, undefined);
  const jobs = await call(client, 'voidly_jobs');
  assert.equal(jobs.value.source, 'home.me.v1');
  assert.deepEqual(jobs.value.jobs, { state: 'unavailable', items: [] });
  const show = await call(client, 'voidly_job_show', { jobId: 'job_123' });
  assert.equal(show.result.isError, true);
  assert.equal(show.value.status, 'unavailable');
  assert.equal(show.value.code, 'jobs_stopped');
  assert.deepEqual(calls, [`${API}/v1/home/me`, `${API}/v1/home/me`, `${API}/v1/agent/jobs/job_123`]);
});

test('MCP board and job mutations sign original JSON bytes once, without claiming award payment', async t => {
  const fixtures = [
    { name: 'voidly_board_post', path: '/v1/agent/board/posts', kind: 'Board' as const,
      field: 'post', args: {}, value: { board: 'market-jobs', title: 'Review data', body: 'Scoped review.' } },
    { name: 'voidly_job_create', path: '/v1/agent/jobs', kind: 'Job' as const,
      field: 'job', args: {}, value: { idempotency_key: IDEMPOTENCY_KEY, title: 'Review data' } },
    { name: 'voidly_board_bid', path: '/v1/agent/jobs/job_123/bids', kind: 'Job' as const,
      field: 'bid', args: { jobId: 'job_123' }, value: { idempotency_key: IDEMPOTENCY_KEY, offer_digest: 'c'.repeat(64) } },
    { name: 'voidly_board_award', path: '/v1/agent/jobs/job_123/award', kind: 'Job' as const,
      field: 'award', args: { jobId: 'job_123' }, value: { idempotency_key: IDEMPOTENCY_KEY, bid_id: 'bid_123', expected_revision: 1 } },
  ];
  for (const fixture of fixtures) {
    const file = await input(fixture.value);
    let count = 0;
    const client = await connect(t, { commandEnv: ENV, commandFetch: async (url, init) => {
      count++;
      assert.equal(String(url), API + fixture.path);
      verifyRequest(init, fixture.kind, 'POST', fixture.path, file.text);
      return Response.json({ [fixture.field]: { id: 'saved_123' }, apiKey: MAIL_KEY }, { status: 201 });
    } });
    const { result, value } = await call(client, fixture.name, { ...fixture.args, inputFile: file.path, confirm: true });
    assert.notEqual(result.isError, true);
    assert.equal(value.status, 'accepted');
    assert.deepEqual(value.result, { [fixture.field]: { id: 'saved_123' } });
    if (fixture.field === 'award') assert.equal(value.paymentStatus, 'unpaid_or_unverified');
    assert.equal(count, 1);
  }
});

test('MCP bounty probe blocks unavailable writes and explicit replay retains the exact idempotency payload', async t => {
  const file = await input({ idempotency_key: IDEMPOTENCY_KEY });
  let phase: 'unavailable' | 'unknown' | 'accepted' = 'unavailable';
  let reads = 0;
  let writes = 0;
  const nonces: string[] = [];
  const client = await connect(t, { commandEnv: ENV, commandFetch: async (url, init) => {
    if (String(url) === `${API}/v1/bounties`) {
      reads++;
      assert.equal(new Headers(init?.headers).has('x-agent-did'), false);
      return phase === 'unavailable' ? Response.json({ error: 'bounties_stopped' }, { status: 503 }) :
        Response.json({ schema: 'voidly-bounty-mvp/v1', tasks: [bounty()] });
    }
    if (String(url) === `${API}/v1/bounties/${BOUNTY_ID}`) {
      assert.equal(init?.method, 'GET');
      return Response.json({ schema: 'voidly-bounty-mvp/v1', ...bounty() });
    }
    writes++;
    assert.equal(String(url), `${API}/v1/bounties/${BOUNTY_ID}/claim`);
    nonces.push(verifyRequest(init, 'Job', 'POST', `/v1/bounties/${BOUNTY_ID}/claim`, file.text));
    if (phase === 'unknown') throw new Error('Synthetic response lost');
    return Response.json({ schema: 'voidly-bounty-mvp/v1', ...bounty({ status: 'claimed', claimable: false }) });
  } });
  const args = { bountyId: BOUNTY_ID, inputFile: file.path, confirm: true };
  const unavailable = await call(client, 'voidly_bounty_claim', args);
  assert.equal(unavailable.result.isError, true);
  assert.equal(unavailable.value.writeDispatched, false);
  assert.equal(writes, 0);
  phase = 'unknown';
  const unknown = await call(client, 'voidly_bounty_claim', args);
  assert.equal(unknown.result.isError, true);
  assert.equal(unknown.value.status, 'outcome_unknown');
  assert.equal(unknown.value.idempotencyKey, IDEMPOTENCY_KEY);
  assert.equal(unknown.value.retrySameInputOnly, true);
  assert.equal(unknown.value.automaticRetry, false);
  assert.equal(writes, 1);
  phase = 'accepted';
  const replay = await call(client, 'voidly_bounty_claim', args);
  assert.notEqual(replay.result.isError, true);
  assert.equal(replay.value.paymentStatus, 'advertised_unfunded');
  assert.equal(replay.value.paid, false);
  assert.equal(replay.value.payoutStatus, 'owner_run_off');
  assert.equal(writes, 2);
  assert.notEqual(nonces[0], nonces[1]);
  assert.equal(reads, 3);
  assert.equal((await call(client, 'voidly_bounty_show', { bountyId: BOUNTY_ID })).value.status, 'ready');
  const invalid = await client.callTool({ name: 'voidly_bounty_show', arguments: { bountyId: '../private' } });
  assert.equal(invalid.isError, true);
  assert.equal(writes, 2);
});

test('MCP mail preserves one send operation through uncertainty, status, inbox and read', async t => {
  const file = await input({ operationId: OPERATION_ID, to: 'agent@example.test', subject: 'A scoped update', text: 'Hello.' });
  const names: string[] = [];
  const client = await connect(t, { commandEnv: ENV, commandFetch: async (url, init) => {
    assert.equal(String(url), `${API}/mcp/mail`);
    assert.equal(init?.redirect, 'manual');
    assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${MAIL_KEY}`);
    const request = JSON.parse(String(init?.body));
    names.push(request.params.name);
    if (request.params.name === 'voidmail_send_once') {
      assert.deepEqual(request.params.arguments, JSON.parse(file.text));
      throw new Error('Synthetic send response lost');
    }
    if (request.params.name === 'voidmail_send_status') {
      assert.deepEqual(request.params.arguments, { operationId: OPERATION_ID });
    } else if (request.params.name === 'voidmail_list_inbox') {
      assert.deepEqual(request.params.arguments, { limit: 2, offset: 3, unreadOnly: true });
    } else {
      assert.equal(request.params.name, 'voidmail_read_email');
      assert.deepEqual(request.params.arguments, { emailId: 'mail_123' });
    }
    return Response.json({ jsonrpc: '2.0', id: request.id,
      result: { structuredContent: { status: 'accepted', text: `Keep this ${MAIL_KEY}`, ownerKey: MAIL_KEY } } });
  } });
  const sent = await call(client, 'voidly_mail_send', { inputFile: file.path, confirm: true });
  assert.equal(sent.result.isError, true);
  assert.equal(sent.value.status, 'outcome_unknown');
  assert.equal(sent.value.operationId, OPERATION_ID);
  assert.equal(sent.value.automaticRetry, false);
  assert.deepEqual(names, ['voidmail_send_once']);
  const status = await call(client, 'voidly_mail_status', { operationId: OPERATION_ID });
  assert.notEqual(status.result.isError, true);
  assert.equal(status.value.providerAccepted, true);
  assert.equal(status.value.deliveryConfirmed, false);
  assert.equal(JSON.stringify(status.value).includes(MAIL_KEY), false);
  await call(client, 'voidly_mail_inbox', { limit: 2, offset: 3, unreadOnly: true });
  await call(client, 'voidly_mail_read', { emailId: 'mail_123' });
  const invalid = await client.callTool({ name: 'voidly_mail_inbox', arguments: { limit: 11 } });
  assert.equal(invalid.isError, true);
  assert.deepEqual(names, ['voidmail_send_once', 'voidmail_send_status', 'voidmail_list_inbox', 'voidmail_read_email']);
});

test('MCP buy uses configured limits, pins listing version and payee, and keeps uncertain payment recovery', async t => {
  const file = await input({ country: 'FR' });
  let lookups = 0;
  let pays = 0;
  const client = await connect(t, { commandEnv: { VOIDLY_WALLET_STATE_DIR: file.directory },
    commandFetch: async (url, init) => {
      lookups++;
      assert.equal(String(url), listing().detailUrl);
      assert.equal(init?.method, 'GET');
      assert.equal(init?.redirect, 'manual');
      return Response.json({ version: '1', item: listing() });
    }, initialWallet: inertWallet({ payX402: async (request: unknown) => {
      pays++;
      assert.deepEqual(request, { url: listing().callUrl, method: 'POST', body: { country: 'FR' },
        maxAmountUsd: '0.02', expectedMarketplace: { listingId: LISTING_ID, version: 4, payTo: PAY_TO } });
      throw new PaymentMayHaveSettledError(QUOTE_ID);
    } }),
  });
  const args = { listingId: LISTING_ID, version: 4, inputFile: file.path, maxUsdc: '0.02', confirm: true };
  const capped = await client.callTool({ name: 'wallet_buy', arguments: { ...args, maxUsdc: '0.06' } });
  assert.equal(capped.isError, true);
  assert.equal(lookups, 0);
  assert.equal(pays, 0);
  const unknown = await call(client, 'wallet_buy', args);
  assert.equal(unknown.result.isError, true);
  assert.equal(unknown.value.paymentMayHaveSettled, true);
  assert.equal(unknown.value.quoteId, QUOTE_ID);
  assert.equal(unknown.value.recoverWith, 'wallet_recover_marketplace');
  assert.equal(unknown.value.doNotRepay, true);
  assert.equal(lookups, 1);
  assert.equal(pays, 1);

  const disallowed = await connect(t, { initialWallet: inertWallet(),
    commandFetch: async () => { assert.fail('Disallowed origin lookup'); } },
  { ...OPTIONS, allowedOrigins: ['https://other.example.test'] });
  assert.equal((await disallowed.callTool({ name: 'wallet_buy', arguments: args })).isError, true);
});

test('MCP seller uncertainty preserves a private durable intent and explicit same-intent resume', async t => {
  const file = await input({ name: 'Example answer', description: 'Returns a short answer', category: 'data',
    upstreamUrl: 'https://seller.example.test/run', method: 'POST', priceAtomic: 10_000,
    inputSchema: { type: 'object', required: ['query'], maxProperties: 1,
      properties: { query: { type: 'string', maxLength: 64 } }, additionalProperties: false },
    outputSchema: { type: 'object', required: ['answer'], maxProperties: 1,
      properties: { answer: { type: 'string', maxLength: 256 } }, additionalProperties: false }, tags: ['example'] });
  let requests = 0;
  const signedPayloads: unknown[] = [];
  const client = await connect(t, {
    commandEnv: { VOIDLY_WALLET_STATE_DIR: file.directory },
    commandFetch: async (url, init) => {
      requests++;
      assert.equal(String(url), `${ORIGIN}/v1/sellers/quickstart`);
      assert.equal(init?.method, 'POST');
      assert.equal(init?.redirect, 'manual');
      throw new Error(`Synthetic upstream error ${MAIL_KEY}`);
    }, initialWallet: inertWallet({ prepareVoidlySellerQuickstart: async (payload: unknown) => {
      signedPayloads.push(payload);
      return { submitUrl: `${ORIGIN}/v1/sellers/quickstart`, body: { payload } };
    } }),
  });
  const args = { listingFile: file.path, confirm: true };
  const unknown = await call(client, 'wallet_sell_quickstart', args);
  assert.equal(unknown.result.isError, true);
  assert.equal(unknown.value.code, 'seller_quickstart_uncertain');
  assert.equal(unknown.value.automaticRetry, false);
  assert.equal(unknown.value.retrySameIntent, true);
  assert.equal(typeof unknown.value.intentFile, 'string');
  assert.equal(typeof unknown.value.secretFile, 'string');
  assert.equal(JSON.stringify(unknown.value).includes(MAIL_KEY), false);
  const intentText = await readFile(unknown.value.intentFile, 'utf8');
  const intent = JSON.parse(intentText);
  assert.match(intent.idempotencyKey, /^[A-Za-z0-9_-]{16,64}$/);
  assert.equal((await stat(unknown.value.intentFile)).mode & 0o777, 0o600);
  assert.equal(requests, 1);
  assert.equal(signedPayloads.length, 1);
  const duplicate = await call(client, 'wallet_sell_quickstart', args);
  assert.equal(duplicate.result.isError, true);
  assert.equal(duplicate.value.code, 'seller_quickstart_existing_intent');
  assert.equal(requests, 1);
  assert.equal(signedPayloads.length, 1);
  const resumed = await call(client, 'wallet_sell_quickstart', { ...args, resumeFile: unknown.value.intentFile });
  assert.equal(resumed.value.code, 'seller_quickstart_uncertain');
  assert.equal(resumed.value.intentFile, unknown.value.intentFile);
  assert.equal(requests, 2);
  assert.deepEqual(signedPayloads[1], signedPayloads[0]);
  assert.equal(await readFile(unknown.value.intentFile, 'utf8'), intentText);
});
