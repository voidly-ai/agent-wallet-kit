import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchMarketplaceListing } from '../src/buyListing.js';

const ID = 'svc_e756b894c55a4026aa66dca4ca293ff5';
const PAY_TO = '0x2222222222222222222222222222222222222222';

function listing(network: 'base' | 'base-sepolia') {
  const mainnet = network === 'base';
  const origin = mainnet ? 'https://x402.voidly.ai' : 'https://x402-staging.voidly.ai';
  const caip = mainnet ? 'eip155:8453' : 'eip155:84532';
  return {
    kind: 'seller', id: ID, version: 4, status: 'live', method: 'POST',
    detailUrl: `${origin}/v1/services/${ID}?network=${caip}&version=4`,
    callUrl: `${origin}/v1/services/${ID}/call`, network: caip,
    asset: mainnet ? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
      : '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    priceUsdcAtomic: '10000', payTo: PAY_TO,
    inputSchema: { type: 'object', required: ['country'] },
    secretSaltHex: 'must-not-return',
  };
}

function fixtureFetch(item: Record<string, unknown>, status = 200): typeof fetch {
  return async () => Response.json({ version: '1', item }, { status });
}

test('selects only the exact seller version from the fixed Base gateway', async () => {
  for (const network of ['base', 'base-sepolia'] as const) {
    const item = listing(network);
    let requests = 0;
    const fetcher: typeof fetch = async (input, init) => {
      requests++;
      assert.equal(String(input), item.detailUrl);
      assert.equal(init?.method, 'GET');
      assert.equal(init?.redirect, 'manual');
      assert.equal(init?.credentials, 'omit');
      assert.equal(init?.cache, 'no-store');
      assert.ok(init?.signal);
      return Response.json({ version: '1', item });
    };
    const selected = await fetchMarketplaceListing(ID, 4, network, fetcher);
    assert.equal(requests, 1);
    assert.deepEqual(selected, {
      kind: 'seller', id: ID, version: 4, status: 'live', method: 'POST',
      detailUrl: item.detailUrl, callUrl: item.callUrl, network: item.network,
      asset: item.asset, priceUsdcAtomic: '10000', payTo: PAY_TO,
      inputSchema: item.inputSchema,
    });
    assert.equal('secretSaltHex' in selected, false);
  }
});

test('rejects changed listing identity and payment coordinates', async () => {
  const base = listing('base-sepolia');
  const badItems: Array<Record<string, unknown>> = [
    { ...base, kind: 'first_party' },
    { ...base, id: 'svc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    { ...base, version: 5 },
    { ...base, status: 'paused' },
    { ...base, method: 'GET' },
    { ...base, detailUrl: 'https://other.example/v1/services/detail' },
    { ...base, callUrl: `${base.callUrl}?quote=untrusted` },
    { ...base, network: 'eip155:8453' },
    { ...base, asset: '0x1111111111111111111111111111111111111111' },
    { ...base, priceUsdcAtomic: '0' },
    { ...base, payTo: '0x0000000000000000000000000000000000000000' },
    { ...base, inputSchema: [] },
  ];
  for (const item of badItems) {
    await assert.rejects(fetchMarketplaceListing(ID, 4, 'base-sepolia', fixtureFetch(item)),
      /Listing detail/);
  }
});

test('invalid input, HTTP errors, redirects and oversized detail fail before payment', async () => {
  let fetches = 0;
  const fetcher: typeof fetch = async () => {
    fetches++;
    return Response.json({ version: '1', item: listing('base') });
  };
  await assert.rejects(fetchMarketplaceListing('../private', 4, 'base', fetcher), /Invalid listing ID/);
  await assert.rejects(fetchMarketplaceListing(ID, 0, 'base', fetcher), /positive safe integer/);
  await assert.rejects(fetchMarketplaceListing(ID, 4, 'polygon' as 'base', fetcher), /Unsupported Base network/);
  assert.equal(fetches, 0);

  await assert.rejects(fetchMarketplaceListing(ID, 4, 'base',
    async () => new Response(null, { status: 302, headers: { location: 'https://other.example' } })),
  /HTTP 302/);
  await assert.rejects(fetchMarketplaceListing(ID, 4, 'base', fixtureFetch(listing('base'), 409)),
    /HTTP 409/);
  await assert.rejects(fetchMarketplaceListing(ID, 4, 'base',
    async () => new Response('x'.repeat(256 * 1024 + 1), {
      headers: { 'content-type': 'application/json' },
    })), /too large/);
  await assert.rejects(fetchMarketplaceListing(ID, 4, 'base',
    async () => new Response('{}', { headers: { 'content-type': 'text/html' } })),
  /must be JSON/);
});
