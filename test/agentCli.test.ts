import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import nacl from 'tweetnacl';
import { runAgentCli, type AgentCliDependencies } from '../src/agentCli.js';
import { runWalletCli } from '../src/cli.js';
import { VOIDLY_CAPABILITIES_URL } from '../src/voidlyCapabilities.js';

const API = 'https://api.voidly.ai';
const HOME_DID = 'did:voidly:Root123';
const AGENT_DID = 'did:voidly:Agent123';
const MAIL_KEY = `vm_${'a'.repeat(64)}`;
const OPERATION_ID = 'send_20261006_0001';
const IDEMPOTENCY_KEY = 'b'.repeat(32);
const HOME_KEY = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
const AGENT_KEY = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(19));

const signerEnv: NodeJS.ProcessEnv = {
  VOIDLY_HOME_ROOT_DID: HOME_DID,
  VOIDLY_HOME_ROOT_SIGNING_SECRET_BASE64: Buffer.from(HOME_KEY.secretKey).toString('base64'),
  VOIDLY_AGENT_DID: AGENT_DID,
  VOIDLY_AGENT_SIGNING_SECRET_BASE64: Buffer.from(AGENT_KEY.secretKey).toString('base64'),
  VOIDLY_MAIL_AGENT_KEY: MAIL_KEY,
};

function offline(): typeof fetch {
  return async () => { throw new Error('Unexpected network request'); };
}

async function jsonFile(_t: TestContext, value: unknown): Promise<{ path: string; text: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'voidly-agent-cli-test-'));
  const path = join(directory, 'input.json');
  const text = JSON.stringify(value, null, 2);
  await writeFile(path, text);
  return { path, text };
}

function verifySignedRequest(init: RequestInit | undefined, kind: 'Home' | 'Board' | 'Job',
  method: 'GET' | 'POST', path: string, did: string, key: Uint8Array, body: string | null): void {
  assert.equal(init?.method, method);
  assert.equal(init?.redirect, 'manual');
  assert.equal(init?.credentials, 'omit');
  assert.equal(init?.cache, 'no-store');
  assert.equal(init?.body ?? null, method === 'GET' ? null : body);
  const headers = new Headers(init?.headers);
  assert.equal(headers.get('x-agent-did'), did);
  assert.equal(headers.get('accept'), 'application/json');
  assert.equal(headers.get('content-type'), method === 'GET' ? null : 'application/json');
  const timestamp = headers.get(`x-${kind}-timestamp`);
  const nonce = headers.get(`x-${kind}-nonce`);
  const signature = headers.get(`x-${kind}-signature`);
  assert.match(timestamp ?? '', /^\d{10}$/);
  assert.ok(Math.abs(Number(timestamp) - Math.floor(Date.now() / 1000)) <= 5);
  assert.match(nonce ?? '', /^[0-9a-f]{32}$/);
  assert.match(signature ?? '', /^(?:[A-Za-z0-9+/]{4}){21}[A-Za-z0-9+/]{2}==$/);
  const domain = kind === 'Home' ? 'voidly-home-read-v1' :
    kind === 'Board' ? 'voidly-board-post-v1' : 'voidly-agent-job-v1';
  const digest = body === null ? [] : [createHash('sha256').update(body, 'utf8').digest('hex')];
  const preimage = [domain, method, path, did, timestamp, nonce, ...digest].join('\n');
  assert.equal(nacl.sign.detached.verify(Buffer.from(preimage), Buffer.from(signature!, 'base64'), key), true,
    `Signature must cover the exact ${kind} request preimage`);
}

test('home signs the fixed read, and jobs preserves Home section states without a jobs collection request', async () => {
  const snapshot = {
    version: 'home.me.v1', observed_at: '2026-10-06T22:00:00Z',
    home: {
      wallet: { state: 'unlinked' }, mail: { state: 'unlinked' },
      jobs: { state: 'unavailable', items: [] },
    },
  };
  let calls = 0;
  const fetcher: typeof fetch = async (url, init) => {
    calls++;
    assert.equal(url, `${API}/v1/home/me`);
    verifySignedRequest(init, 'Home', 'GET', '/v1/home/me', HOME_DID, HOME_KEY.publicKey, null);
    assert.equal(new Headers(init?.headers).has('x-job-signature'), false);
    return Response.json(snapshot);
  };
  const home = await runAgentCli(['home'], { env: signerEnv, fetcher });
  assert.equal(home.status, 'ready');
  assert.deepEqual((home.snapshot as typeof snapshot).home.wallet, { state: 'unlinked' });
  const jobs = await runAgentCli(['jobs'], { env: signerEnv, fetcher });
  assert.equal(jobs.status, 'ready');
  assert.equal(jobs.source, 'home.me.v1');
  assert.deepEqual(jobs.jobs, snapshot.home.jobs);
  assert.equal(calls, 2);
});

test('board post, job create, bid, and award sign the exact path and raw JSON bytes', async t => {
  const cases = [
    { argv: ['board', 'post'], path: '/v1/agent/board/posts', kind: 'Board' as const,
      input: { board: 'market-jobs', title: 'Help review a data set', body: 'Need a reviewer.' } },
    { argv: ['jobs', 'create'], path: '/v1/agent/jobs', kind: 'Job' as const,
      input: { idempotency_key: IDEMPOTENCY_KEY, title: 'Review data', description: 'Review the data set.' } },
    { argv: ['board', 'bid', 'job_123'], path: '/v1/agent/jobs/job_123/bids', kind: 'Job' as const,
      input: { idempotency_key: IDEMPOTENCY_KEY, offer_digest: 'c'.repeat(64) } },
    { argv: ['board', 'award', 'job_123'], path: '/v1/agent/jobs/job_123/award', kind: 'Job' as const,
      input: { idempotency_key: IDEMPOTENCY_KEY, bid_id: 'bid_123', expected_revision: 1 } },
  ];
  for (const entry of cases) {
    const { path: inputPath, text } = await jsonFile(t, entry.input);
    let calls = 0;
    const result = await runAgentCli([...entry.argv, '--input', inputPath], {
      env: signerEnv,
      fetcher: async (url, init) => {
        calls++;
        assert.equal(url, `${API}${entry.path}`);
        verifySignedRequest(init, entry.kind, 'POST', entry.path, AGENT_DID, AGENT_KEY.publicKey, text);
        assert.equal(new Headers(init?.headers).has('x-home-signature'), false);
        const field = entry.argv[1] === 'post' ? 'post' : entry.argv[1] === 'create' ? 'job' :
          entry.argv[1] === 'bid' ? 'bid' : 'award';
        return Response.json({ [field]: { id: 'stored_123' }, ownerKey: MAIL_KEY }, { status: 201 });
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.status, 'accepted');
    const field = entry.argv[1] === 'post' ? 'post' : entry.argv[1] === 'create' ? 'job' :
      entry.argv[1] === 'bid' ? 'bid' : 'award';
    assert.deepEqual(result.result, { [field]: { id: 'stored_123' } });
    assert.equal(JSON.stringify(result).includes(MAIL_KEY), false);
    if (entry.argv[1] === 'award') assert.equal(result.paymentStatus, 'unpaid_or_unverified');
  }
});

test('jobs show signs an empty-body digest when DID credentials are configured', async () => {
  const path = '/v1/agent/jobs/job_123';
  const result = await runAgentCli(['jobs', 'show', 'job_123'], {
    env: signerEnv,
    fetcher: async (url, init) => {
      assert.equal(url, `${API}${path}`);
      verifySignedRequest(init, 'Job', 'GET', path, AGENT_DID, AGENT_KEY.publicKey, '');
      return Response.json({ job: { id: 'job_123', status: 'open' } });
    },
  });
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.result, { job: { id: 'job_123', status: 'open' } });
});

test('a successful write with an unreadable response remains uncertain', async t => {
  const { path } = await jsonFile(t, {
    board: 'market-jobs', title: 'Review a data set', body: 'Scoped review.',
  });
  let calls = 0;
  const result = await runAgentCli(['board', 'post', '--input', path], {
    env: signerEnv,
    fetcher: async () => {
      calls++;
      return new Response('not JSON', { status: 201, headers: { 'Content-Type': 'application/json' } });
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.status, 'outcome_unknown');
  assert.equal(result.doNotRetry, true);
});

test('hosted mail sends one JSON-RPC request with an agent bearer key, then checks the saved operation ID', async t => {
  const { path } = await jsonFile(t, {
    operationId: OPERATION_ID, to: 'receiver@example.test', subject: 'Status', text: 'The review is ready.',
  });
  const names: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(url, `${API}/mcp/mail`);
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'manual');
    assert.equal(init?.credentials, 'omit');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${MAIL_KEY}`);
    const rpc = JSON.parse(String(init?.body));
    assert.equal(rpc.jsonrpc, '2.0');
    assert.equal(rpc.method, 'tools/call');
    assert.match(rpc.id, /^[0-9a-f-]{36}$/);
    names.push(rpc.params.name);
    if (rpc.params.name === 'voidmail_send_once') {
      assert.deepEqual(rpc.params.arguments, {
        operationId: OPERATION_ID, to: 'receiver@example.test', subject: 'Status', text: 'The review is ready.',
      });
      return Response.json({ jsonrpc: '2.0', id: rpc.id,
        result: { structuredContent: { status: 'accepted', providerMessageId: 'provider_1', agentKey: MAIL_KEY } } });
    }
    assert.equal(rpc.params.name, 'voidmail_send_status');
    assert.deepEqual(rpc.params.arguments, { operationId: OPERATION_ID });
    return Response.json({ jsonrpc: '2.0', id: rpc.id,
      result: { content: [{ type: 'text', text: JSON.stringify({ status: 'accepted', operationId: OPERATION_ID }) }] } });
  };
  const sent = await runAgentCli(['mail', 'send', '--input', path], { env: signerEnv, fetcher });
  assert.equal(sent.status, 'accepted');
  assert.equal(sent.providerAccepted, true);
  assert.equal(sent.deliveryConfirmed, false);
  assert.equal(sent.automaticRetry, false);
  assert.equal(JSON.stringify(sent).includes(MAIL_KEY), false);
  const checked = await runAgentCli(['mail', 'status', OPERATION_ID], { env: signerEnv, fetcher });
  assert.equal(checked.status, 'accepted');
  assert.deepEqual(checked.result, { status: 'accepted', operationId: OPERATION_ID });
  assert.deepEqual(names, ['voidmail_send_once', 'voidmail_send_status']);
});

test('uncertain hosted mail send makes no automatic retry and keeps the original operation ID', async t => {
  const { path } = await jsonFile(t, {
    operationId: OPERATION_ID, to: 'receiver@example.test', subject: 'Status', text: 'Hello',
  });
  let calls = 0;
  const result = await runAgentCli(['mail', 'send', '--input', path], {
    env: signerEnv, fetcher: async () => { calls++; throw new Error('Transport failed after request'); },
  });
  assert.equal(calls, 1);
  assert.equal(result.status, 'outcome_unknown');
  assert.equal(result.operationId, OPERATION_ID);
  assert.equal(result.automaticRetry, false);
  assert.match(String(result.next), /same operation ID/);
});

test('mail inbox and read use hosted tools with bounded arguments and remove credentials from results', async () => {
  const names: string[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    const rpc = JSON.parse(String(init?.body));
    names.push(rpc.params.name);
    if (rpc.params.name === 'voidmail_list_inbox') {
      assert.deepEqual(rpc.params.arguments, { limit: 3, offset: 20, unreadOnly: true });
      return Response.json({ jsonrpc: '2.0', id: rpc.id,
        result: { structuredContent: { messages: [{ id: 'msg_123', subject: `key ${MAIL_KEY}` }], token: MAIL_KEY } } });
    }
    assert.deepEqual(rpc.params.arguments, { emailId: 'msg_123' });
    return Response.json({ jsonrpc: '2.0', id: rpc.id,
      result: { structuredContent: { id: 'msg_123', text: 'Plain text only' } } });
  };
  const inbox = await runAgentCli(['mail', 'inbox', '--limit', '3', '--offset', '20', '--unread-only'],
    { env: signerEnv, fetcher });
  assert.equal(inbox.status, 'ready');
  assert.equal(JSON.stringify(inbox).includes(MAIL_KEY), false);
  assert.equal((inbox.result as { messages: Array<{ subject: string }> }).messages[0]!.subject,
    'key [redacted: Voidmail key]');
  const read = await runAgentCli(['mail', 'read', 'msg_123'], { env: signerEnv, fetcher });
  assert.deepEqual(read.result, { id: 'msg_123', text: 'Plain text only' });
  assert.deepEqual(names, ['voidmail_list_inbox', 'voidmail_read_email']);
});

test('invalid commands, unsafe files, IDs, and mail input are refused before network use', async t => {
  const { path } = await jsonFile(t, { idempotency_key: 'not-hex', title: 'Bad job' });
  const dependencies: AgentCliDependencies = { env: signerEnv, fetcher: offline() };
  await assert.rejects(runAgentCli(['jobs', 'create', '--input', path], dependencies), /idempotency_key/);
  await assert.rejects(runAgentCli(['board', 'bid', '../other', '--input', path], dependencies), /idempotency_key/);
  await assert.rejects(runAgentCli(['mail', 'inbox', '--limit', '11'], dependencies), /--limit/);
  await assert.rejects(runAgentCli(['mail', 'read', '../secret'], dependencies), /Invalid email ID/);
  await assert.rejects(runAgentCli(['mail', 'status', 'short'], dependencies), /Invalid mail operation ID/);
  await assert.rejects(runAgentCli(['mail', 'send', '--input', path], dependencies), /Mail input requires/);
  await assert.rejects(runAgentCli(['board', 'post', '--input', path, '--unknown', 'x'], dependencies), /voidly-agent-wallet board post/);
  const directory = await mkdtemp(join(tmpdir(), 'voidly-agent-cli-link-'));
  const linked = join(directory, 'linked.json');
  await symlink(path, linked);
  await assert.rejects(runAgentCli(['board', 'post', '--input', linked], dependencies),
    /regular JSON file|ELOOP|symbolic link/i);
});

test('the package CLI dispatches the new commands without loading a payment wallet', async () => {
  const result = await runWalletCli(['home'], {
    env: signerEnv,
    restoreWallet: async () => { throw new Error('payment wallet must remain untouched'); },
    fetcher: async () => Response.json({ version: 'home.me.v1', observed_at: '2026-10-06T22:00:00Z',
      home: { jobs: { state: 'unavailable' } } }),
  });
  assert.equal(result.command, 'home');
  assert.equal(result.status, 'ready');
});

test('capabilities reads the fixed public manifest and preserves the publisher availability warning', async () => {
  const manifest = {
    schema: 'voidly.agent-capabilities/v1', revision: '2026-10-06.3', sourceBase: 'abc123',
    sourceStatus: 'source_snapshot_not_served_proof',
    coverage: { status: 'partial', exhaustive: false },
    actions: [{ id: 'home', availability: 'source_wired_flagged', callable: false,
      endpoint: { method: 'GET', url: `${API}/v1/home/me`, backend_available: 'unverified' } }],
  };
  const result = await runAgentCli(['capabilities'], {
    env: {}, fetcher: async (url, init) => {
      assert.equal(url, VOIDLY_CAPABILITIES_URL);
      assert.equal(init?.method, 'GET');
      return Response.json(manifest);
    },
  });
  assert.equal(result.command, 'capabilities');
  assert.equal(result.actionCount, 1);
  assert.equal((result.coverage as { exhaustive: boolean }).exhaustive, false);
  assert.equal((result.actions as typeof manifest.actions)[0]!.endpoint.backend_available, 'unverified');
  assert.match(String(result.warning), /partial/);
});
