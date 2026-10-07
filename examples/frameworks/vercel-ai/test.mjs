import assert from 'node:assert/strict';
import test from 'node:test';
import { runCatalog, ENDPOINT, TOOL } from './main.mjs';

// Exercise the installed framework adapter with an in-memory HTTP transport.
// A global fetch trap prevents accidental real requests in the offline suite.
globalThis.fetch = async () => { throw new Error('Real network is forbidden in offline tests'); };

function fixture({ missing = false, toolError = false, invalidJson = false } = {}) {
  const calls = [];
  const fetch = async (input, init) => {
    const request = new Request(input, init);
    assert.equal(request.url, ENDPOINT);
    assert.equal(request.headers.has('authorization'), false);
    assert.equal(init.redirect, 'error');
    if (request.method === 'GET') return new Response(null, { status: 405 });
    if (request.method === 'DELETE') return new Response(null, { status: 204 });
    const rpc = await request.json();
    calls.push(rpc);
    if (rpc.method === 'notifications/initialized') return new Response(null, { status: 202 });
    let result;
    if (rpc.method === 'initialize') {
      result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'offline-fixture', version: '1.0.0' } };
    } else if (rpc.method === 'tools/list') {
      result = { tools: missing ? [] : [{
        name: TOOL, description: 'Offline catalog fixture',
        inputSchema: { type: 'object', properties: { limit: { type: 'integer' } }, required: ['limit'], additionalProperties: false },
      }] };
    } else if (rpc.method === 'tools/call') {
      assert.equal(rpc.params.name, TOOL);
      assert.deepEqual(rpc.params.arguments, { limit: 1 });
      if (invalidJson) return new Response('not-json', { headers: { 'content-type': 'application/json' } });
      result = { content: [{ type: 'text', text: JSON.stringify({ items: [{ id: 'offline-only' }] }) }], isError: toolError };
    } else {
      throw new Error(`Unexpected offline RPC: ${rpc.method}`);
    }
    return Response.json({ jsonrpc: '2.0', id: rpc.id, result });
  };
  return { fetch, calls };
}

test('real adapter discovers and executes exactly the chosen public read', async () => {
  const f = fixture();
  const result = await runCatalog(f.fetch);
  assert.equal(result.endpoint, ENDPOINT);
  assert.equal(result.tool, TOOL);
  assert.deepEqual(result.arguments, { limit: 1 });
  assert.equal(result.result.content[0].text, '{"items":[{"id":"offline-only"}]}');
  assert.equal(f.calls.filter(call => call.method === 'tools/call').length, 1);
});

test('missing tool fails without executing a different tool', async () => {
  const f = fixture({ missing: true });
  await assert.rejects(runCatalog(f.fetch), /unavailable/);
  assert.equal(f.calls.filter(call => call.method === 'tools/call').length, 0);
});

test('remote tool error is not reported as a successful catalog result', async () => {
  const f = fixture({ toolError: true });
  await assert.rejects(runCatalog(f.fetch));
  assert.equal(f.calls.filter(call => call.method === 'tools/call').length, 1);
});

test('malformed response fails without a second outbound tool call', async () => {
  const f = fixture({ invalidJson: true });
  await assert.rejects(runCatalog(f.fetch));
  assert.equal(f.calls.filter(call => call.method === 'tools/call').length, 1);
});
