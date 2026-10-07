import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerSpendAllowanceTools, type SpendAllowanceToolDependencies } from '../src/mcpAllowanceTools.js';
import type { SpendAllowanceGrant } from '../src/spendAllowance.js';

const NOW = Date.parse('2026-10-07T12:00:00.000Z');
const ID = '12345678-1234-4234-8234-123456789abc';
const OWNER = `0x${'1'.repeat(40)}` as const;
const PAYEE = `0x${'2'.repeat(40)}` as const;
const QUOTE = `0x${'3'.repeat(64)}`;

function grant(): SpendAllowanceGrant {
  return { version: 'voidpay-spend-allowance/v1', grantId: ID,
    origin: 'https://x402-staging.voidly.ai', network: 'eip155:84532',
    asset: '0x036cbd53842c5426634e7929541ec2318f3dcf7e', owner: OWNER, payer: OWNER,
    dailyLimitAtomic: '100000000', perCallLimitAtomic: '10000000',
    validAfter: NOW / 1_000 - 60, expiresAt: NOW / 1_000 + 86_400,
    listings: [{ listingId: 'service-1234', version: 3, payTo: PAYEE }] };
}
function status(patch: Record<string, unknown> = {}) {
  return { grant: grant(), status: 'active', day: '2026-10-07', usedAtomic: '0', remainingAtomic: '100000000', ...patch };
}
function buyInput(patch: Record<string, unknown> = {}) {
  return { grantId: ID, listingId: 'service-1234', version: 3, input: { text: 'Hello' }, maxUsdc: '1', ...patch };
}

async function connect(t: TestContext, patch: Partial<SpendAllowanceToolDependencies> = {}) {
  const events: string[] = [];
  const server = new McpServer({ name: 'allowance-test', version: '1' });
  registerSpendAllowanceTools(server, {
    now: () => NOW,
    grant: async () => { events.push('grant'); return status(); },
    status: async () => { events.push('status'); return status(); },
    revoke: async () => { events.push('revoke'); return status({ status: 'revoked' }); },
    enabledGrant: async () => { events.push('enabledGrant'); return grant(); },
    buy: async () => { events.push('buy'); return { status: 'delivered', quoteId: QUOTE }; },
    ...patch,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'allowance-client', version: '1' });
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, events };
}

test('MCP grant and revoke reject absent or false approval before any callback', async t => {
  const { client, events } = await connect(t);
  const listed = (await client.listTools()).tools;
  assert.equal(listed.length, 4);
  for (const name of ['wallet_allowance_grant', 'wallet_allowance_revoke']) {
    for (const confirm of [undefined, false, 'true', 1]) {
      const args = name.endsWith('grant') ? { grant: grant(), confirm } : { grantId: ID, confirm };
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true);
    }
  }
  assert.deepEqual(events, []);
  const result = await client.callTool({ name: 'wallet_allowance_grant', arguments: { grant: grant(), confirm: true } });
  assert.equal(result.isError, undefined);
  assert.deepEqual(events, ['grant']);
  assert.equal((result.structuredContent as any).grant.grantId, ID);
  const revoke = await client.callTool({ name: 'wallet_allowance_revoke', arguments: { grantId: ID, confirm: true } });
  assert.equal((revoke.structuredContent as any).status, 'revoked');
  assert.deepEqual(events, ['grant', 'revoke']);
});

test('MCP delegated buy requires a durable local enabled grant before server or payment access', async t => {
  let localReads = 0;
  const { client, events } = await connect(t, { enabledGrant: async () => { localReads++; return null; } });
  const result = await client.callTool({ name: 'wallet_allowance_buy', arguments: buyInput() });
  assert.equal(result.isError, true);
  assert.equal(localReads, 1);
  assert.deepEqual(events, []);
});

test('MCP delegated buy validates local constraints then authoritative status, without per-call confirmation', async t => {
  let captured: unknown;
  const { client, events } = await connect(t, { buy: async request => { captured = request; return { status: 'delivered' }; } });
  const result = await client.callTool({ name: 'wallet_allowance_buy', arguments: buyInput() });
  assert.equal(result.isError, undefined);
  assert.deepEqual(events, ['enabledGrant', 'status']);
  assert.deepEqual(captured, { grant: grant(), listingId: 'service-1234', version: 3,
    input: { text: 'Hello' }, maxUsdc: '1' });
  for (const patch of [{ version: 4 }, { listingId: 'service-9999' }, { maxUsdc: '11' }]) {
    captured = undefined;
    events.length = 0;
    const bad = await client.callTool({ name: 'wallet_allowance_buy', arguments: buyInput(patch) });
    assert.equal(bad.isError, true);
    assert.equal(captured, undefined);
    assert.deepEqual(events, ['enabledGrant']);
  }
});

test('MCP rejects malformed JSON and budget inputs before local grant, signer or transport callbacks', async t => {
  const { client, events } = await connect(t);
  for (const patch of [{ input: { text: 'a'.repeat(8_193) } }, { maxUsdc: '0' },
    { maxUsdc: '1e2' }, { input: [] }, { confirm: true }, { maxUsdc: '-1' }]) {
    const result = await client.callTool({ name: 'wallet_allowance_buy', arguments: buyInput(patch) });
    assert.equal(result.isError, true);
    assert.deepEqual(events, []);
  }
});

test('MCP refuses changed, revoked, stale, malformed or exhausted authoritative status before buying', async t => {
  let authoritative: unknown = status();
  const { client, events } = await connect(t, { status: async () => authoritative });
  for (const patch of [
    { grant: { ...grant(), perCallLimitAtomic: '9999999' } }, { status: 'revoked' },
    { status: 'not_yet_active' }, { status: 'expired' }, { status: { internal: 'secret' } },
    { day: '2026-10-06' }, { usedAtomic: '99500000', remainingAtomic: '500000' },
    { remainingAtomic: '100000001' }, { usedAtomic: 0 }, { remainingAtomic: { private: 'secret' } },
    { unknown: 'secret' },
  ]) {
    authoritative = status(patch);
    events.length = 0;
    const result = await client.callTool({ name: 'wallet_allowance_buy', arguments: buyInput() });
    assert.equal(result.isError, true);
    assert.deepEqual(events, ['enabledGrant']);
    assert.doesNotMatch(JSON.stringify(result), /secret/);
  }
});

test('MCP rechecks expiry after authoritative lookup and refuses an ambiguous local listing payee', async t => {
  let clock = NOW;
  const { client, events } = await connect(t, { now: () => clock, status: async () => {
    clock = grant().expiresAt * 1_000;
    return status();
  } });
  const result = await client.callTool({ name: 'wallet_allowance_buy', arguments: buyInput() });
  assert.equal(result.isError, true);
  assert.deepEqual(events, ['enabledGrant']);
  const ambiguous = grant();
  ambiguous.listings.push({ ...ambiguous.listings[0]!, payTo: OWNER });
  const second = await connect(t, { enabledGrant: async () => ambiguous });
  const bad = await second.client.callTool({ name: 'wallet_allowance_buy', arguments: buyInput() });
  assert.equal(bad.isError, true);
  assert.deepEqual(second.events, []);
});

test('MCP sanitizes arbitrary callback failures and preserves safe original-identity recovery output', async t => {
  const { client } = await connect(t, { status: async () => { throw new Error('/private/secret raw-auth-key'); } });
  const failed = await client.callTool({ name: 'wallet_allowance_status', arguments: { grantId: ID } });
  assert.equal(failed.isError, true);
  assert.doesNotMatch(JSON.stringify(failed), /raw-auth-key|\/private\/secret/);
  const recovery = { error: 'Payment may have settled', paymentMayHaveSettled: true, doNotRepay: true,
    quoteId: QUOTE, recoverWith: 'wallet_recover_marketplace' };
  const second = await connect(t, { buy: async () => recovery });
  const held = await second.client.callTool({ name: 'wallet_allowance_buy', arguments: buyInput() });
  assert.equal(held.isError, true);
  assert.deepEqual(held.structuredContent, recovery);
});
