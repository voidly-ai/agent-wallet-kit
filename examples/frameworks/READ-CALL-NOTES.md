# Public MCP read checks

These notes describe bounded checks of the example adapters, not a payment or
whole-platform release check. The endpoint was
`https://api.voidly.ai/mcp/voidpay`; the selected tool was `voidpay_services` with
`{"limit":1}`. No Authorization header, model request, wallet, signature or payment
was used.

On 2026-10-07 UTC, all five examples (LangChain, CrewAI, OpenAI Agents SDK,
Vercel AI SDK and Mastra) each returned public service data from a real tool call. The response
included qualified inventory and separately marked the x402 marketplace page
`availability: "unavailable"`. The examples preserve that field. This does not
establish that a listed service is available to buy, that an outside seller is
active, or that a payment or delivery succeeded.

The first OpenAI smoke run found a Python MCP2 attribute-name difference before
the tool call. The corrected example serializes with protocol aliases and passed
a subsequent call. Its offline tests now use the installed SDK's actual model
types.

The first CrewAI run reached the server but returned `INVALID_INPUT`: its adapter
included unset optional cursor fields as null. That response was retained as a
failure, not called a successful catalog read. The corrected adapter preserves schema
validation but omits arguments that were not supplied. Its subsequent call
returned public service data. The raw result is adapter text and can represent
multiple content blocks; explicit gateway errors are treated as failures.

Data, listings and endpoint availability can change after these observations.
The scripts print their fresh result; this file is not a cached expected output.
