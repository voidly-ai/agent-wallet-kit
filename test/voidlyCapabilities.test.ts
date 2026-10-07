import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createWalletMcpServer } from '../src/mcp.js';
import { readVoidlyCapabilities, VOIDLY_CAPABILITIES_URL } from '../src/voidlyCapabilities.js';

const manifest = {
  schema: 'voidly.agent-capabilities/v1',
  revision: '2026-10-06.2',
  sourceBase: 'source-commit',
  sourceStatus: 'source_snapshot_not_served_proof',
  coverage: { status: 'partial', exhaustive: false, note: 'Source inventory, not a live-route check.' },
  actions: [
    {
      id: 'wallet', availability: 'local_kit_separate',
      endpoint: { method: 'LOCAL', url: 'npm:@voidly/agent-wallet@0.2.0', backend_available: false },
      auth: { kind: 'local_wallet' }, price: { mode: 'resource_terms' },
    },
    {
      id: 'directory', availability: 'release_gated', callable: false,
      endpoint: { method: 'GET', url: 'https://api.voidly.ai/v1/directory', backend_available: 'unverified' },
      relatedEndpoints: [{ method: 'GET', url: 'https://api.voidly.ai/v2/marketplace/directory' }],
      auth: { kind: 'public_read' }, price: { mode: 'no_fee_in_route_source' },
    },
    {
      id: 'home', availability: 'source_wired_flagged',
      endpoint: { method: 'GET', url: 'https://api.voidly.ai/v1/home/me', backend_available: 'unverified' },
      auth: { kind: 'root_did_ed25519_one_use_proof', details: 'Fresh local root signature per read.' },
      price: { mode: 'no_fee_in_route_source', details: 'No payment on this read.' },
      mcp: { name: 'voidly_home', callable: false, servedVerified: false },
      limits: ['Migration and feature flag required; source is not served proof.'],
      example: { method: 'GET', url: 'https://api.voidly.ai/v1/home/me', prerequisite: 'Join first.' },
    },
  ],
};

test('keyless MCP capability call reads one fixed manifest and preserves partial availability', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (input, init) => {
    calls++;
    assert.equal(input, VOIDLY_CAPABILITIES_URL);
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'manual');
    assert.equal(init?.cache, 'no-store');
    assert.equal(new Headers(init?.headers).get('accept'), 'application/json');
    return Response.json(manifest);
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createWalletMcpServer({ network: 'base-sepolia',
    limits: { perCallUsd: '0.10', dailyUsd: '1' } }, { capabilitiesFetch: fetcher });
  const client = new Client({ name: 'capabilities-test', version: '0.1.0' });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    assert.equal(calls, 0);
    const result = await client.callTool({ name: 'voidly_capabilities', arguments: {} });
    assert.equal(result.isError, undefined);
    assert.equal(calls, 1);
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    assert.equal(payload.manifestUrl, VOIDLY_CAPABILITIES_URL);
    assert.equal(payload.coverage.exhaustive, false);
    assert.equal(payload.sourceStatus, 'source_snapshot_not_served_proof');
    assert.equal(payload.actionCount, 3);
    assert.equal(payload.actions[0].endpoint.url, 'npm:@voidly/agent-wallet@0.2.0');
    assert.equal(payload.actions[1].callable, false);
    assert.equal(payload.actions[1].endpoint.backend_available, 'unverified');
    assert.deepEqual(payload.actions[1].relatedEndpoints, manifest.actions[1]!.relatedEndpoints);
    assert.equal(payload.actions[2].mcp.callable, false);
    assert.equal(payload.actions[2].mcp.servedVerified, false);
    assert.match(payload.actions[2].auth.details, /Fresh local root/);
    assert.match(payload.actions[2].price.details, /No payment/);
    assert.match(payload.actions[2].limits[0], /not served proof/);
    assert.equal(payload.actions[2].example.prerequisite, 'Join first.');
    assert.match(payload.warning, /partial/);
  } finally {
    await client.close();
    await server.close();
  }
});

test('missing, redirected, malformed, oversized, and duplicate manifests fail closed', async () => {
  const fetcher = (response: Response): typeof fetch => async () => response;
  await assert.rejects(readVoidlyCapabilities(fetcher(new Response(null, { status: 404 }))), /unavailable \(HTTP 404\)/);
  await assert.rejects(readVoidlyCapabilities(fetcher(new Response(null, {
    status: 302, headers: { Location: 'https://elsewhere.example/manifest.json' },
  }))), /unavailable \(HTTP 302\)/);
  await assert.rejects(readVoidlyCapabilities(fetcher(new Response('<html>unavailable</html>', {
    headers: { 'content-type': 'text/html' },
  }))), /did not return JSON/);
  await assert.rejects(readVoidlyCapabilities(fetcher(Response.json({ ...manifest, schema: 'wrong' }))), /schema validation/);
  await assert.rejects(readVoidlyCapabilities(fetcher(Response.json({
    ...manifest, actions: [{ ...manifest.actions[0], endpoint: { method: 'LOCAL', url: 'npm:@voidly/agent-wallet@0.2.0' } }],
  }))), /schema validation/);
  await assert.rejects(readVoidlyCapabilities(fetcher(new Response('x'.repeat(1_000_001), {
    headers: { 'content-type': 'application/json' },
  }))), /size limit/);
  await assert.rejects(readVoidlyCapabilities(fetcher(Response.json({
    ...manifest, actions: [manifest.actions[0], manifest.actions[0]],
  }))), /duplicate action IDs/);
});
