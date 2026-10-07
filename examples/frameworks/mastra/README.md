# Voidly catalog read with Mastra

Use `@mastra/mcp@2.1.2` with `@mastra/core@1.74.0` to call the public hosted Voidpay MCP server directly. No model, provider credential, Voidly key, wallet or `.env` file is needed.

## Run

Use **Node.js 24 or newer**. From this folder:

```sh
npm ci --ignore-scripts
npm test
npm start
```

`npm test` is offline. `npm start` makes a real public network read:

- Endpoint: `https://api.voidly.ai/mcp/voidpay`
- MCP tool: `voidpay_services`
- Arguments: `{ "limit": 1 }`

The program prints JSON containing the framework, endpoint, tool, arguments and returned result. Catalog contents vary; an empty result is possible. A listing describes a service and does not prove availability, delivery or a purchase. Errors produce a nonzero exit.

## Adapter calls

`new MCPClient({ servers: { voidpay: { url } } })` manages the connection. `listTools()` prefixes names with the server key, so the adapter tool is `voidpay_voidpay_services`. Its current `execute` API takes the input object directly, followed by optional execution context. `disconnect()` runs in `finally`. `protocolVersion: "legacy"` selects the initialize handshake.

The transport fixes the endpoint and permits one outbound `tools/call` request for this exact tool and input. Discovery, initialization and session cleanup use additional protocol requests. The example rejects redirected requests, supplies request timeouts and sends no Authorization header. It does not register an agent, sign, buy, pay or activate a service.

## Qualification

The pinned installed adapter passed **4 offline tests** on Node.js 25.4.0: successful discovery/execution, missing tool, remote tool error and malformed response. Tests use in-memory HTTP responses and a real-network trap; no MCP server or model was contacted. A separate real public call is recorded in the [read-call notes](../READ-CALL-NOTES.md); offline tests alone do not establish live service behavior.

Direct versions are pinned in `package.json`; `package-lock.json` pins the complete dependency resolution and package integrity values. The examples are application folders (`private: true`), not packages to publish to npm. Dependencies and local evidence are not checked in.

## Optional model integration

You can later pass the single selected tool to your framework's model or Agent API. That is a separate integration: configure the chosen provider's credentials, expect possible model charges, and retain explicit tool authorization. No model call is included or executed here.

## Primary sources

Reviewed 2026-10-07. Installed package declarations and implementation were checked alongside the official documentation; moving documentation URLs may describe later versions.

- [Official MCPClient API](https://mastra.ai/reference/tools/mcp-client)
- [Official tool execution API](https://mastra.ai/reference/tools/create-tool)
- [Exact npm adapter metadata](https://registry.npmjs.org/@mastra%2fmcp/2.1.2)
- [Exact npm core metadata](https://registry.npmjs.org/@mastra%2fcore/1.74.0)
- [Official adapter source](https://github.com/mastra-ai/mastra/tree/main/packages/mcp)
