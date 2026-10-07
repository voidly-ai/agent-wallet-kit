import { MCPClient } from '@mastra/mcp';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export const ENDPOINT = 'https://api.voidly.ai/mcp/voidpay';
export const TOOL = 'voidpay_services';
export const ARGS = Object.freeze({ limit: 1 });

// Pin the destination and operation even if an adapter tries a transport retry.
// fetchImpl is injected only by the offline test; normal runs use native fetch.
function readOnlyTransport(fetchImpl) {
  let calls = 0;
  return async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== ENDPOINT) throw new Error('Unexpected MCP destination');
    if (request.headers.has('authorization')) throw new Error('This public read needs no authorization');
    if (request.method === 'POST') {
      const rpc = await request.clone().json();
      if (!['initialize', 'notifications/initialized', 'tools/list', 'tools/call'].includes(rpc.method)) {
        throw new Error('Unexpected MCP method');
      }
      if (rpc.method === 'tools/call') {
        if (rpc.params?.name !== TOOL || rpc.params?.arguments?.limit !== 1 ||
            Object.keys(rpc.params.arguments).length !== 1) throw new Error('Unexpected MCP tool or arguments');
        if (++calls > 1) throw new Error('A second tool call is disabled in this quickstart');
      }
    } else if (!['GET', 'DELETE'].includes(request.method)) {
      throw new Error('Unexpected MCP transport method');
    }
    // GET is the transport event stream; DELETE can close an MCP session.
    return fetchImpl(request, {
      redirect: 'error',
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
    });
  };
}

export async function runCatalog(fetchImpl = globalThis.fetch) {
  const client = new MCPClient({
    id: 'voidly-mastra-quickstart',
    timeout: 15_000,
    servers: {
      voidpay: {
        url: new URL(ENDPOINT),
        protocolVersion: 'legacy',
        allowedHosts: ['api.voidly.ai'],
        enableServerLogs: false,
        onToolError: 'throw',
        fetch: readOnlyTransport(fetchImpl),
      },
    },
  });
  try {
    const tools = await client.listTools();
    // Mastra prefixes tools with the configured server name, not a model name.
    const tool = tools[`voidpay_${TOOL}`];
    if (typeof tool?.execute !== 'function') throw new Error('voidpay_services is unavailable on this server');
    const result = await tool.execute(ARGS, { abortSignal: AbortSignal.timeout(15_000) });
    if (result?.isError === true || result?.error === true) throw new Error('MCP tool returned an error');
    return { framework: 'mastra', endpoint: ENDPOINT, tool: TOOL, arguments: ARGS, result };
  } finally {
    await client.disconnect();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCatalog().then(
    result => console.log(JSON.stringify(result, null, 2)),
    error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; },
  );
}
