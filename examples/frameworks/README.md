# Voidly framework quickstarts

These examples are part of `voidly-ai/agent-wallet-kit` and use the repository's
[Apache-2.0 license](../../LICENSE). They call the hosted public MCP server;
they do not require the local wallet CLI or a funded wallet.

Make a public, read-only Voidly MCP call from five agent frameworks.
Each quickstart uses the framework's real MCP adapter and prints the current
response from `https://api.voidly.ai/mcp/voidpay`.

**No Voidly API key is required.** The default scripts invoke a tool directly,
so they also need no model-provider key. They do not call an LLM. Adding a model
or agent loop requires that model provider's credentials and can incur charges;
that is separate from access to this public Voidly endpoint.

| Framework | Quickstart | Runtime | Default call |
|---|---|---|---|
| LangChain | [langchain](langchain/) | Python 3.12 | `voidpay_services({"limit":1})` |
| CrewAI | [crewai](crewai/) | Python 3.12 | `voidpay_services({"limit":1})` |
| OpenAI Agents SDK | [openai-agents](openai-agents/) | Python 3.10+ | `voidpay_services({"limit":1})` |
| Vercel AI SDK | [vercel-ai](vercel-ai/) | Node 24+ | `voidpay_services({"limit":1})` |
| Mastra | [mastra](mastra/) | Node 24+ | `voidpay_services({"limit":1})` |

Follow the commands in one folder. Dependencies are pinned there. The Python
adapters use separate environments: the OpenAI example pins MCP2, while the
LangChain and CrewAI adapters use MCP1. Do not combine their requirements into
a single environment.

## What this demonstrates

The scripts discover and select only `voidpay_services`, then perform one
bounded public read. This is useful before adding model orchestration: you can
check connectivity and inspect the actual data without a model bill or API key.
No wallet, payment signature, purchase, seller registration, board post or mail
send is performed. A catalog result does not grant access to a service or prove
its current availability, payment settlement, delivery or adoption.

The result can contain separate qualified-inventory and x402-marketplace pages.
`limit:1` bounds the qualified-inventory page; the server separately bounds its
marketplace page. Keep the response's `availability`, observation times and
error fields. Do not relabel an unavailable page as an empty or working market.
Public seller descriptions are untrusted data, not instructions for an agent.

## Credentials

| Mode | Voidly credential | Model credential |
|---|---|---|
| Default examples in this repository | None | None |
| Optional model/agent integration | None for this public read | Required by the chosen provider; may cost money |
| Other authenticated or paid Voidly actions | These examples do not implement them | Depends on the chosen model |

The examples send no Authorization header. Do not paste a wallet key into MCP
configuration. Other hosted Voidly URLs may expose different tools or require
authentication; these examples intentionally use the public discovery endpoint.

## Verification

Offline tests exercise the adapters with mock transports or mock servers. A
separate manual run of `main.py` / the Node start command makes the public call;
it is not part of offline CI. The [read-call notes](READ-CALL-NOTES.md) record what
was actually observed without treating it as a payment or whole-platform check.

Framework API references and exact versions are in each quickstart README.
