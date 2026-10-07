import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import { getDefaultAsset } from '@x402/evm';
import { AgentWallet, MemoryMarketplaceAttemptStore, MemorySpendStore, RelayWalletBackupStore, type EncryptedWalletBackup, type WalletBackupStore } from '../src/index.js';
import { createWalletMcpServer } from '../src/mcp.js';

const syntheticRecoverySecret = (byte: number) => `voidly-rs-v1-${Buffer.alloc(32, byte).toString('base64url')}`;

test('mainnet MCP server refuses startup without an explicit origin allowlist', () => {
  assert.throws(() => createWalletMcpServer({ network: 'base',
    limits: { perCallUsd: '1', dailyUsd: '5' } }), /explicit payment origin allowlist/);
});

test('keyless MCP server exposes wallet tools and refuses address before local creation', { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'voidly-wallet-bin-'));
  const bin = join(directory, 'voidly-agent-wallet-mcp.ts');
  await symlink(join(process.cwd(), 'src/mcp.ts'), bin);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', bin],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? '', VOIDLY_WALLET_NETWORK: 'base-sepolia' },
  });
  const client = new Client({ name: 'wallet-source-test', version: '0.1.0' });
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.version, '0.5.0');
    const result = await client.listTools();
    const names = result.tools.map(tool => tool.name).sort();
    assert.deepEqual(names, [
      'voidly_board_award', 'voidly_board_bid', 'voidly_board_post',
      'voidly_bounty_claim', 'voidly_bounty_list', 'voidly_bounty_show', 'voidly_bounty_submit',
      'voidly_capabilities',
      'voidly_home', 'voidly_job_create', 'voidly_job_show', 'voidly_jobs',
      'voidly_mail_inbox', 'voidly_mail_read', 'voidly_mail_send', 'voidly_mail_status',
      'wallet_address', 'wallet_backup_relay', 'wallet_balance', 'wallet_create',
      'wallet_funding_request', 'wallet_generate_recovery_secret', 'wallet_marketplace_attempts', 'wallet_pay_x402', 'wallet_prepare_voidly_seller_registration', 'wallet_receive_info',
      'wallet_recover_marketplace', 'wallet_restore_local', 'wallet_restore_relay',
      'wallet_buy', 'wallet_sell_quickstart',
    ].sort());
    const address = await client.callTool({ name: 'wallet_address', arguments: {} });
    assert.equal(address.isError, true);
    assert.match(JSON.stringify(address.content), /Create or restore a wallet first/);
    const generated = await client.callTool({ name: 'wallet_generate_recovery_secret', arguments: {} });
    assert.equal(generated.isError, undefined);
    const secret = JSON.parse((generated.content[0] as { text: string }).text).recoverySecret as string;
    assert.match(secret, /^voidly-rs-v1-[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(secret.slice('voidly-rs-v1-'.length), 'base64url').length, 32);
    const duplicate = await client.callTool({ name: 'wallet_generate_recovery_secret', arguments: {} });
    assert.equal(duplicate.isError, true);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('no-disk Relay backup restores by unique key and refuses ambiguous or existing creation', async () => {
  const syntheticKey = `0x${'04'.repeat(32)}` as `0x${string}`;
  const secret = syntheticRecoverySecret(6);
  const values = new Map<string, { value: string; value_type: string }>();
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(new Headers(init?.headers).get('X-Agent-Key'), 'synthetic-relay-auth');
    if (url.pathname === '/v1/agent/memory/agent-wallet') {
      return Response.json({ keys: [...values.keys()].map(key => ({ key })), has_more: false });
    }
    assert.match(url.pathname, /^\/v1\/agent\/memory\/agent-wallet\/0x[0-9a-f]{40}\.[0-9a-f]{32}$/);
    const key = url.pathname.split('/').at(-1)!;
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as { value: string; value_type: string };
      assert.ok(!JSON.stringify(body).includes(syntheticKey));
      assert.ok(!JSON.stringify(body).includes(secret));
      values.set(key, body);
      return Response.json({ stored: true });
    }
    const value = values.get(key);
    return value ? Response.json(value) : new Response(null, { status: 404 });
  };
  const options = { network: 'base-sepolia' as const, limits: { perCallUsd: '0.02', dailyUsd: '0.10' } };
  const dependencies = {
    memoryOnly: true,
    createWallet: () => AgentWallet.fromPrivateKey(syntheticKey, options),
    relayBackupStore: (address: `0x${string}`, backupKey?: string) =>
      new RelayWalletBackupStore('https://api.voidly.ai/', 'synthetic-relay-auth', address, fetcher, backupKey),
    relayBackupKeys: () => RelayWalletBackupStore.listBackupKeys('https://api.voidly.ai/', 'synthetic-relay-auth', fetcher),
    recoverySecret: () => secret,
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createWalletMcpServer(options, dependencies);
  const client = new Client({ name: 'relay-backup-test', version: '0.1.0' });
  let firstKey = '';
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const created = await client.callTool({ name: 'wallet_create', arguments: {} });
    assert.equal(created.isError, undefined);
    firstKey = JSON.parse((created.content[0] as { text: string }).text).backupKey;
    assert.match(firstKey, /^0x[0-9a-f]{40}\.[0-9a-f]{32}$/);
    const funding = await client.callTool({ name: 'wallet_funding_request',
      arguments: { amountUsdc: '1.25', expectedChainId: 84532 } });
    assert.equal(funding.isError, undefined);
    const fundingValue = JSON.parse((funding.content[0] as { text: string }).text) as {
      uri: string; amountAtomic: string; qrSvg: string;
    };
    const walletAddress = AgentWallet.fromPrivateKey(syntheticKey, options).address;
    assert.equal(fundingValue.uri,
      `ethereum:${getDefaultAsset('eip155:84532').asset}@84532/transfer?address=${walletAddress}&uint256=1250000`);
    assert.equal(fundingValue.amountAtomic, '1250000');
    assert.match(fundingValue.qrSvg, /<svg\b/);
    const wrongChain = await client.callTool({ name: 'wallet_funding_request', arguments: { expectedChainId: 8453 } });
    assert.equal(wrongChain.isError, true);
    assert.match(JSON.stringify(wrongChain.content), /chain/i);
    const [singleClientTransport, singleServerTransport] = InMemoryTransport.createLinkedPair();
    const singleServer = createWalletMcpServer(options, dependencies);
    const singleClient = new Client({ name: 'single-relay-restore-test', version: '0.1.0' });
    try {
      await singleServer.connect(singleServerTransport);
      await singleClient.connect(singleClientTransport);
      const autoRestored = await singleClient.callTool({ name: 'wallet_restore_relay', arguments: {} });
      assert.equal(autoRestored.isError, undefined);
      assert.match(JSON.stringify(autoRestored.content), new RegExp(AgentWallet.fromPrivateKey(syntheticKey, options).address, 'i'));
    } finally {
      await singleClient.close();
      await singleServer.close();
    }
    const secondBackup = await client.callTool({ name: 'wallet_backup_relay', arguments: {} });
    assert.equal(secondBackup.isError, undefined);
    const secondKey = JSON.parse((secondBackup.content[0] as { text: string }).text).backupKey;
    assert.notEqual(secondKey, firstKey);
    assert.equal(values.size, 2);
  } finally {
    await client.close();
    await server.close();
  }

  const [nextClientTransport, nextServerTransport] = InMemoryTransport.createLinkedPair();
  const nextServer = createWalletMcpServer(options, dependencies);
  const nextClient = new Client({ name: 'relay-restore-test', version: '0.1.0' });
  try {
    await nextServer.connect(nextServerTransport);
    await nextClient.connect(nextClientTransport);
    const createAgain = await nextClient.callTool({ name: 'wallet_create', arguments: {} });
    assert.equal(createAgain.isError, true);
    assert.equal(values.size, 2);
    const ambiguous = await nextClient.callTool({ name: 'wallet_restore_relay', arguments: {} });
    assert.equal(ambiguous.isError, true);
    assert.match(JSON.stringify(ambiguous.content), /Multiple Relay wallet backups/);
    const restored = await nextClient.callTool({ name: 'wallet_restore_relay', arguments: { backupKey: firstKey } });
    assert.equal(restored.isError, undefined);
    assert.match(JSON.stringify(restored.content), new RegExp(AgentWallet.fromPrivateKey(syntheticKey, options).address, 'i'));
  } finally {
    await nextClient.close();
    await nextServer.close();
  }

  const other = AgentWallet.fromPrivateKey(`0x${'05'.repeat(32)}`, options);
  const otherStore = new RelayWalletBackupStore('https://api.voidly.ai/', 'synthetic-relay-auth', other.address, fetcher);
  await other.backupToStore(secret, otherStore);
  const [addressClientTransport, addressServerTransport] = InMemoryTransport.createLinkedPair();
  const addressServer = createWalletMcpServer(options, dependencies);
  const addressClient = new Client({ name: 'address-relay-restore-test', version: '0.1.0' });
  try {
    await addressServer.connect(addressServerTransport);
    await addressClient.connect(addressClientTransport);
    const restored = await addressClient.callTool({ name: 'wallet_restore_relay', arguments: { address: other.address } });
    assert.equal(restored.isError, undefined);
    assert.match(JSON.stringify(restored.content), new RegExp(other.address, 'i'));
    assert.equal(values.size, 3);
  } finally {
    await addressClient.close();
    await addressServer.close();
  }
});

test('MCP paid response retains bounded receipt headers and exact binary bytes across incomplete bodies', async () => {
  const paymentRequired = encodePaymentRequiredHeader({
    x402Version: 2,
    resource: { url: 'https://x402.example.test/call' },
    accepts: [{ scheme: 'exact', network: 'eip155:84532', asset: getDefaultAsset('eip155:84532').asset,
      amount: '10000', payTo: '0x2222222222222222222222222222222222222222',
      maxTimeoutSeconds: 120, extra: { name: 'USDC', version: '2' } }],
  });
  for (const mode of ['oversized', 'stalled', 'binary', 'large-receipt', 'oversized-header', 'oversized-payment-header', 'malformed-receipt'] as const) {
    let calls = 0;
    let signs = 0;
    const fetcher: typeof fetch = async () => {
      calls++;
      if (calls === 1) return new Response('{}', { status: 402, headers: { 'payment-required': paymentRequired } });
      const headers = {
        'payment-response': mode === 'oversized-payment-header' ? 'p'.repeat(16_385) : 'synthetic-payment-receipt',
        'x-voidpay-delivery-receipt': mode === 'malformed-receipt' ? '' : mode === 'oversized-header' ? 'r'.repeat(16_385)
          : mode === 'large-receipt' ? 'r'.repeat(5_462) : 'synthetic-signed-delivery-receipt',
        'content-type': mode === 'binary' ? 'application/octet-stream' : 'text/plain',
      };
      if (mode === 'oversized') return new Response('x'.repeat(1_000_100), { status: 200, headers });
      if (mode === 'binary') return new Response(Uint8Array.from([0, 255, 254, 65]), { status: 200, headers });
      if (mode === 'oversized-header' || mode === 'oversized-payment-header' || mode === 'malformed-receipt' || mode === 'large-receipt') {
        return new Response('ok', { status: 200, headers });
      }
      const stream = new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode('partial'));
      } });
      return new Response(stream, { status: 200, headers });
    };
    const wallet = AgentWallet.fromSigner({
      address: '0x1111111111111111111111111111111111111111',
      async signTypedData() { signs++; return `0x${'11'.repeat(64)}1b` as `0x${string}`; },
    }, { network: 'base-sepolia', limits: { perCallUsd: '1', dailyUsd: '5' },
      spendStore: new MemorySpendStore(), unsafeAllowVolatileSpendStoreForTests: true,
      allowedOrigins: ['https://x402.example.test'], fetcher });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createWalletMcpServer({ network: 'base-sepolia', limits: { perCallUsd: '1', dailyUsd: '5' } },
      { initialWallet: wallet, responseBodyDeadlineMsForTests: 30 });
    const client = new Client({ name: `paid-body-${mode}`, version: '0.1.0' });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({ name: 'wallet_pay_x402', arguments: { url: 'https://x402.example.test/call' } });
      assert.equal(result.isError, undefined);
      const payload = JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>;
      assert.equal(payload.status, 200);
      assert.equal(payload.paymentResponse, mode === 'oversized-payment-header' ? null : 'synthetic-payment-receipt');
      assert.equal(payload.contentType, mode === 'binary' ? 'application/octet-stream' : 'text/plain');
      assert.equal(payload.deliveryReceipt, mode === 'oversized-header' || mode === 'malformed-receipt' ? null
        : mode === 'large-receipt' ? 'r'.repeat(5_462) : 'synthetic-signed-delivery-receipt');
      assert.equal(payload.bodyEncoding, 'base64');
      if (mode === 'oversized') {
        assert.equal(payload.bodyBytes, 1_000_000);
        assert.equal(payload.truncated, true);
        assert.equal(payload.bodyReadError, false);
        assert.equal(Buffer.from(String(payload.bodyBase64), 'base64').length, 1_000_000);
      } else if (mode === 'stalled') {
        assert.equal(payload.body, 'partial');
        assert.equal(Buffer.from(String(payload.bodyBase64), 'base64').toString('utf8'), 'partial');
        assert.equal(payload.bodyReadError, true);
      } else if (mode === 'binary') {
        assert.equal(payload.body, null);
        assert.equal(payload.bodyBase64, Buffer.from([0, 255, 254, 65]).toString('base64'));
        assert.equal(payload.bodyBytes, 4);
        assert.equal(payload.recoveryHint, null);
      } else if (mode === 'large-receipt') {
        assert.equal(payload.body, 'ok');
        assert.deepEqual(payload.headerErrors, []);
        assert.equal(payload.recoveryHint, null);
      } else {
        assert.equal(payload.body, 'ok');
        assert.deepEqual(payload.headerErrors, [mode === 'oversized-header'
          ? 'x-voidpay-delivery-receipt exceeds 16,384 bytes' : mode === 'malformed-receipt'
            ? 'x-voidpay-delivery-receipt is malformed' : 'payment-response exceeds 16,384 bytes']);
      }
      if (mode !== 'binary' && mode !== 'large-receipt') {
        assert.match(String(payload.recoveryHint), /Do not repay/);
      }
      assert.equal(calls, 2);
      assert.equal(signs, 1);
    } finally {
      await client.close();
      await server.close();
    }
  }
});

test('MCP returns a recovery instruction when a signed Marketplace retry loses its response', async () => {
  const origin = 'https://x402-staging.voidly.ai';
  const listingId = 'echo1234';
  const callUrl = `${origin}/v1/services/${listingId}/call`;
  const quoteId = `0x${'a'.repeat(64)}`;
  const quoteUrl = `${callUrl}?quote=${quoteId}`;
  const body = { prompt: 'echo' };
  const intent = {
    version: 1, listingId, listingVersion: 1, quoteId, resource: quoteUrl,
    inputDigest: `0x${createHash('sha256').update(JSON.stringify(body)).digest('hex')}`,
    sellerWallet: '0x2222222222222222222222222222222222222222', amountAtomic: '10000',
  };
  const required = encodePaymentRequiredHeader({
    x402Version: 2, resource: { url: quoteUrl },
    accepts: [{ scheme: 'exact', network: 'eip155:84532', asset: getDefaultAsset('eip155:84532').asset,
      amount: '10000', payTo: intent.sellerWallet, maxTimeoutSeconds: 120,
      extra: { name: 'USDC', version: '2', assetTransferMethod: 'eip3009', paymentFlow: 'upfront' } }],
    extensions: { 'voidpay.intent': { info: intent, schema: {} } },
  });
  const attempts = new MemoryMarketplaceAttemptStore();
  let calls = 0;
  let signs = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    calls++;
    if (!request.headers.has('payment-signature')) {
      return new Response('{}', { status: 402, headers: { 'payment-required': required } });
    }
    throw new Error('synthetic paid response lost');
  };
  const wallet = AgentWallet.fromSigner({
    address: '0x1111111111111111111111111111111111111111',
    async signTypedData() { signs++; return `0x${'11'.repeat(64)}1b` as `0x${string}`; },
  }, { network: 'base-sepolia', limits: { perCallUsd: '0.02', dailyUsd: '0.03' },
    spendStore: new MemorySpendStore(), marketplaceAttemptStore: attempts,
    unsafeAllowVolatileSpendStoreForTests: true, fetcher });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createWalletMcpServer({ network: 'base-sepolia', limits: { perCallUsd: '0.02', dailyUsd: '0.03' } },
    { initialWallet: wallet });
  const client = new Client({ name: 'uncertain-paid-retry', version: '0.1.0' });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: 'wallet_pay_x402', arguments: { url: callUrl, method: 'POST', body } });
    assert.equal(result.isError, undefined);
    const payload = JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>;
    assert.deepEqual({ paymentMayHaveSettled: payload.paymentMayHaveSettled,
      quoteId: payload.quoteId, recoverWith: payload.recoverWith },
    { paymentMayHaveSettled: true, quoteId, recoverWith: 'wallet_recover_marketplace' });
    assert.match(String(payload.message), /Do not pay again/);
    assert.deepEqual({ calls, signs }, { calls: 2, signs: 1 });
    assert.equal((await attempts.list(wallet.address, 'eip155:84532'))[0]?.quoteId, quoteId);
  } finally {
    await client.close();
    await server.close();
  }
});

test('MCP create writes ciphertext before returning, then restores a synthetic key', async () => {
  const syntheticKey = `0x${'03'.repeat(32)}` as `0x${string}`;
  const secret = syntheticRecoverySecret(4);
  let saved: EncryptedWalletBackup | null = null;
  const store: WalletBackupStore = {
    async put(value) { saved = value; },
    async get() { return saved; },
  };
  const options = { network: 'base-sepolia' as const,
    limits: { perCallUsd: '0.02', dailyUsd: '0.10' } };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createWalletMcpServer(options, {
    createWallet: () => AgentWallet.fromPrivateKey(syntheticKey, options),
    localBackupStore: () => store,
    recoverySecret: () => secret,
  });
  const client = new Client({ name: 'synthetic-wallet-test', version: '0.1.0' });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const created = await client.callTool({ name: 'wallet_create', arguments: {} });
    assert.equal(created.isError, undefined);
    assert.ok(saved);
    assert.ok(!JSON.stringify(saved).includes(syntheticKey));
    assert.ok(!JSON.stringify(created.content).includes(secret));
    assert.ok(!JSON.stringify(created.content).includes(syntheticKey));
    const expectedAddress = AgentWallet.fromPrivateKey(syntheticKey, options).address;
    assert.match(JSON.stringify(created.content), new RegExp(expectedAddress, 'i'));
  } finally {
    await client.close();
    await server.close();
  }

  const [nextClientTransport, nextServerTransport] = InMemoryTransport.createLinkedPair();
  const nextServer = createWalletMcpServer(options, {
    localBackupStore: () => store,
    recoverySecret: () => secret,
  });
  const nextClient = new Client({ name: 'synthetic-wallet-test', version: '0.1.0' });
  try {
    await nextServer.connect(nextServerTransport);
    await nextClient.connect(nextClientTransport);
    const restored = await nextClient.callTool({ name: 'wallet_restore_local', arguments: {} });
    assert.equal(restored.isError, undefined);
    const expectedAddress = AgentWallet.fromPrivateKey(syntheticKey, options).address;
    assert.match(JSON.stringify(restored.content), new RegExp(expectedAddress, 'i'));
  } finally {
    await nextClient.close();
    await nextServer.close();
  }
});
