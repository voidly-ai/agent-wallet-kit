import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import nacl from 'tweetnacl';
import { runAgentCli } from '../src/agentCli.js';
import { runWalletCli } from '../src/cli.js';

const API = 'https://api.voidly.ai';
const ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const KEY = 'a'.repeat(32);
const PAIR = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31));
const ENV = { VOIDLY_AGENT_DID: 'did:voidly:Agent123',
  VOIDLY_AGENT_SIGNING_SECRET_BASE64: Buffer.from(PAIR.secretKey).toString('base64') };
const SCHEMA = 'voidly-bounty-mvp/v1';
function bounty(overrides: Record<string, unknown> = {}) {
  return { id: ID, title: 'Observe a public target', instructions: 'Record the result.',
    reward_atomic: '1000000', reward_currency: 'USDC', reward_decimals: 6,
    reward_status: 'advertised_unfunded', expires_at_ms: 1_800_000_000_000,
    status: 'open', claimable: true, payable: false, paid: false,
    payout_status: 'owner_run_off', ...overrides };
}
function list(tasks = [bounty()]) { return Response.json({ schema: SCHEMA, tasks }); }
async function input(value: unknown) {
  const path = join(await mkdtemp(join(tmpdir(), 'voidly-bounty-cli-')), 'input.json');
  const text = JSON.stringify(value, null, 2);
  await writeFile(path, text);
  return { path, text };
}
function verify(init: RequestInit | undefined, action: string, text: string) {
  assert.equal(init?.method, 'POST');
  assert.equal(init?.body, text);
  assert.equal(init?.redirect, 'manual');
  assert.equal(init?.credentials, 'omit');
  assert.equal(init?.cache, 'no-store');
  const headers = new Headers(init?.headers);
  assert.equal(headers.get('content-type'), 'application/json');
  assert.equal(headers.get('x-agent-did'), ENV.VOIDLY_AGENT_DID);
  const timestamp = headers.get('x-job-timestamp')!;
  const nonce = headers.get('x-job-nonce')!;
  assert.match(timestamp, /^\d{10}$/);
  assert.match(nonce, /^[0-9a-f]{32}$/);
  const digest = createHash('sha256').update(text, 'utf8').digest('hex');
  const message = ['voidly-agent-job-v1', 'POST', `/v1/bounties/${ID}/${action}`,
    ENV.VOIDLY_AGENT_DID, timestamp, nonce, digest].join('\n');
  assert.ok(nacl.sign.detached.verify(Buffer.from(message),
    Buffer.from(headers.get('x-job-signature')!, 'base64'), PAIR.publicKey));
  return nonce;
}

test('bounty list and show use fixed public routes with no credentials or payment wallet', async () => {
  for (const action of ['list', 'show']) {
    let calls = 0;
    const result = await runWalletCli(['bounty', action, ...(action === 'show' ? [ID] : [])], {
      env: ENV,
      restoreWallet: async () => { assert.fail('No payment wallet'); },
      fetcher: async (url, init) => {
        calls++;
        assert.equal(url, API + '/v1/bounties' + (action === 'show' ? `/${ID}` : ''));
        assert.equal(init?.method, 'GET');
        assert.equal(init?.redirect, 'manual');
        assert.equal(init?.credentials, 'omit');
        assert.equal(init?.body, undefined);
        const headers = new Headers(init?.headers);
        assert.equal(headers.has('x-agent-did'), false);
        assert.equal(headers.has('authorization'), false);
        return action === 'list' ? list() : Response.json({ schema: SCHEMA, ...bounty(),
          claimant_did: 'private', result_text: 'private evidence', secretKey: 'do not print' });
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.status, 'ready');
    assert.equal(result.source, SCHEMA);
    assert.equal(JSON.stringify(result).includes('private'), false);
    const item = action === 'list' ? (result.tasks as Record<string, unknown>[])[0] : result.result;
    assert.deepEqual(item, bounty());
    if (action === 'list') assert.equal(result.limit, 20);
  }
});

test('bounty writes probe B411 then sign exact request bytes and remain unpaid', async () => {
  for (const action of ['claim', 'submit']) {
    const saved = await input({ idempotency_key: KEY,
      ...(action === 'submit' ? { result_text: 'Private evidence summary.' } : {}) });
    const requests: string[] = [];
    const result = await runWalletCli(['bounty', action, ID, '--input', saved.path], {
      env: ENV, restoreWallet: async () => { assert.fail('No payment wallet'); },
      fetcher: async (url, init) => {
        requests.push(String(url));
        if (requests.length === 1) {
          assert.equal(init?.method, 'GET');
          assert.equal(new Headers(init?.headers).has('x-job-signature'), false);
          return list([]);
        }
        verify(init, action, saved.text);
        return Response.json({ schema: SCHEMA,
          ...bounty({ status: action === 'claim' ? 'claimed' : 'submitted', claimable: false }),
          result_text: 'Private evidence summary.', ownerKey: 'do not print' });
      },
    });
    assert.deepEqual(requests, [API + '/v1/bounties', `${API}/v1/bounties/${ID}/${action}`]);
    assert.equal(result.status, 'accepted');
    assert.equal(result.automaticRetry, false);
    assert.equal(result.payable, false);
    assert.equal(result.paid, false);
    assert.equal(result.paymentStatus, 'advertised_unfunded');
    assert.equal(JSON.stringify(result).includes('Private evidence'), false);
  }
});

test('unavailable, redirected, or incompatible feature probes never sign or dispatch a write', async () => {
  const saved = await input({ idempotency_key: KEY });
  const cases = [
    () => new Response('missing', { status: 404 }),
    () => Response.json({ error: 'bounty_storage_unavailable' }, { status: 503 }),
    () => new Response(null, { status: 302, headers: { Location: 'https://example.test' } }),
    () => Response.json({ schema: 'other/v1', tasks: [] }),
    () => Response.json({ schema: SCHEMA, tasks: [bounty({ paid: true })] }),
    () => Response.json({ schema: SCHEMA, tasks: [bounty({ reward_status: 'funded' })] }),
    () => Response.json({ schema: SCHEMA, tasks: Array(21).fill(bounty()) }),
    () => { throw new Error(ENV.VOIDLY_AGENT_SIGNING_SECRET_BASE64); },
  ];
  for (const response of cases) {
    let calls = 0;
    const result = await runAgentCli(['bounty', 'claim', ID, '--input', saved.path], {
      env: {}, fetcher: async (_url, init) => {
        calls++;
        assert.equal(init?.method, 'GET');
        assert.equal(new Headers(init?.headers).has('x-job-signature'), false);
        return response();
      },
    });
    assert.equal(calls, 1);
    assert.notEqual(result.status, 'accepted');
    assert.equal(result.writeDispatched, false);
    assert.equal(result.automaticRetry, false);
    assert.equal(JSON.stringify(result).includes(ENV.VOIDLY_AGENT_SIGNING_SECRET_BASE64), false);
  }
});

test('explicit same-file recovery uses a fresh nonce even when the current task is no longer claimable', async () => {
  const saved = await input({ idempotency_key: KEY });
  const nonces: string[] = [];
  let posts = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    if (init?.method === 'GET') return list([bounty({ status: 'submitted', claimable: false })]);
    nonces.push(verify(init, 'claim', saved.text));
    posts++;
    if (posts === 1) throw new Error('lost reply with secret ' + ENV.VOIDLY_AGENT_SIGNING_SECRET_BASE64);
    return Response.json({ schema: SCHEMA, ...bounty({ status: 'claimed', claimable: false }) });
  };
  const argv = ['bounty', 'claim', ID, '--input', saved.path];
  const unknown = await runAgentCli(argv, { env: ENV, fetcher });
  assert.equal(posts, 1);
  assert.equal(unknown.status, 'outcome_unknown');
  assert.equal(unknown.idempotencyKey, KEY);
  assert.equal(unknown.retrySameInputOnly, true);
  assert.equal(JSON.stringify(unknown).includes(ENV.VOIDLY_AGENT_SIGNING_SECRET_BASE64), false);
  const recovered = await runAgentCli(argv, { env: ENV, fetcher });
  assert.equal(posts, 2);
  assert.equal(recovered.status, 'accepted');
  assert.notEqual(nonces[0], nonces[1]);
});

test('uncertain write responses produce one POST and retain the original recovery key', async () => {
  const saved = await input({ idempotency_key: KEY, result_text: 'Evidence.' });
  const replies = [
    () => Response.json({ error: 'bounty_storage_unavailable' }, { status: 503 }),
    () => new Response(null, { status: 302, headers: { Location: 'https://example.test' } }),
    () => new Response('broken', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    () => Response.json({ schema: SCHEMA, ...bounty({ status: 'claimed', claimable: false }) }),
    () => Response.json({ schema: SCHEMA, ...bounty({ status: 'submitted', claimable: false, id: OTHER_ID }) }),
    () => Response.json({ schema: SCHEMA, ...bounty({ status: 'submitted', claimable: false, paid: true }) }),
    () => Response.json({ schema: SCHEMA, ...bounty({ status: 'submitted', claimable: false }) }, { status: 202 }),
  ];
  for (const reply of replies) {
    let posts = 0;
    const result = await runAgentCli(['bounty', 'submit', ID, '--input', saved.path], {
      env: ENV, fetcher: async (_url, init) => {
        if (init?.method === 'GET') return list();
        posts++; return reply();
      },
    });
    assert.equal(posts, 1);
    assert.equal(result.status, 'outcome_unknown');
    assert.equal(result.idempotencyKey, KEY);
    assert.equal(result.automaticRetry, false);
    assert.equal(result.retrySameInputOnly, true);
  }
});

test('known stop, refusal, conflict, and missing write route remain distinct', async () => {
  const saved = await input({ idempotency_key: KEY });
  for (const [http, code, status] of [[503, 'bounties_stopped', 'unavailable'],
    [401, 'unknown_agent', 'refused'], [403, 'bounty_operator_required', 'refused'],
    [409, 'bounty_replay_conflict', 'conflict'], [404, 'bounty_not_found', 'unavailable'],
    [429, 'job_rate_limited', 'failed']] as const) {
    const result = await runAgentCli(['bounty', 'claim', ID, '--input', saved.path], {
      env: ENV, fetcher: async (_url, init) => init?.method === 'GET' ? list() :
        Response.json({ error: code }, { status: http }),
    });
    assert.equal(result.status, status);
    assert.equal(result.code, code);
    assert.equal(result.retrySameInputOnly, undefined);
  }
});

test('rejects malformed CLI input locally, including byte limits and extra payment fields', async () => {
  const noNetwork: typeof fetch = async () => { assert.fail('Must not send'); };
  for (const argv of [['bounty'], ['bounty', 'list', '--limit', '100'], ['bounty', 'show', '../evil'],
    ['bounty', 'claim', ID], ['bounty', 'accept', ID], ['bounty', 'submit', ID, '--input', 'a', '--input', 'b']]) {
    await assert.rejects(runAgentCli(argv, { env: {}, fetcher: noNetwork }));
  }
  for (const [action, payload] of [
    ['claim', { idempotency_key: 'short' }],
    ['claim', { idempotency_key: KEY, pay: true }],
    ['submit', { idempotency_key: KEY, result_text: '  ' }],
    ['submit', { idempotency_key: KEY, result_text: 'é'.repeat(2049) }],
    ['submit', { idempotency_key: KEY, result_text: 'ok', extra: true }],
  ] as const) {
    const saved = await input(payload);
    await assert.rejects(runAgentCli(['bounty', action, ID, '--input', saved.path],
      { env: ENV, fetcher: noNetwork }), /Bounty input/);
  }
  const saved = await input({ idempotency_key: KEY });
  const linked = saved.path + '.link';
  await symlink(saved.path, linked);
  await assert.rejects(runAgentCli(['bounty', 'claim', ID, '--input', linked],
    { env: ENV, fetcher: noNetwork }), /ELOOP|symbolic link/i);
});

test('a valid feature check still requires credentials before dispatch', async () => {
  const saved = await input({ idempotency_key: KEY });
  let calls = 0;
  await assert.rejects(runAgentCli(['bounty', 'claim', ID, '--input', saved.path], {
    env: {}, fetcher: async (_url, init) => {
      calls++; assert.equal(init?.method, 'GET'); return list();
    },
  }), /agent DID and signing secret/);
  assert.equal(calls, 1);
});

test('read response IDs and unsafe payment assertions are rejected, and credentials are redacted', async () => {
  for (const override of [{ id: OTHER_ID }, { payable: true }, { payout_status: 'paid' },
    { reward_atomic: '10000001' }, { status: ['open'] }]) {
    const result = await runAgentCli(['bounty', 'show', ID], { env: {},
      fetcher: async () => Response.json({ schema: SCHEMA, ...bounty(override) }) });
    assert.equal(result.status, 'unavailable');
  }
  const result = await runAgentCli(['bounty', 'list'], { env: ENV,
    fetcher: async () => list([bounty({ instructions: ENV.VOIDLY_AGENT_SIGNING_SECRET_BASE64 })]) });
  assert.equal(result.status, 'ready');
  assert.equal(JSON.stringify(result).includes(ENV.VOIDLY_AGENT_SIGNING_SECRET_BASE64), false);
});
