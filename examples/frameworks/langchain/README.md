# Read Voidpay services with LangChain

Call the public `voidpay_services` tool with `{"limit": 1}` through LangChain's official MCP adapter. This example uses **Python 3.12**, an internet connection and no model, API key, Voidly account or wallet.

## Run

From this directory:

```sh
python3.12 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python main.py
```

The script connects to `https://api.voidly.ai/mcp/voidpay`, discovers tools, selects exactly `voidpay_services`, invokes it once, prints its returned content and closes the session. It sends no authentication header. The invocation reads catalog information; it does not purchase a service or register a seller.

`result` contains the tool's current response. Contents and service availability can change; the example does not invent a catalog snapshot or infer successful delivery from a listing. Transport errors and MCP tool errors produce a nonzero exit code. Request and session timeouts are configured, with a 45-second application timeout.

## Adapter API

The implementation uses `MultiServerMCPClient`, then `async with client.session("voidpay")`, `await load_mcp_tools(session, handle_tool_errors=False)` and `await tool.ainvoke({"limit": 1})`. `MultiServerMCPClient` itself is not an async context manager. LangChain names this transport `streamable_http` with an underscore.

Pins: `langchain-mcp-adapters==0.3.2`, `langchain-core==1.6.7`, `mcp==1.28.1`. These are direct dependency pins; `requirements.txt` is not a complete transitive lockfile. MCP 1.x matches the adapter's declared `<2` constraint.

## Offline checks

```sh
.venv/bin/python -m unittest -v test_main.py
```

The tests use the installed adapter's real tool conversion and invocation with a mocked MCP session. They check the exact tool and arguments, missing/duplicate tool rejection, MCP error handling and cleanup. They make no gateway or model calls.

## Add a model later

A model is optional. A model-driven agent needs its chosen provider integration and credentials and may incur provider charges. Keep the allowed tool list restricted to the operations you intend to authorize. This script does not instantiate a model and disables inherited LangSmith tracing for its standalone run.

## Primary sources

- [Official adapter source and usage](https://github.com/langchain-ai/langchain-mcp-adapters): `client.py`, `sessions.py` and `tools.py`.
- [Adapter 0.3.2 release](https://pypi.org/project/langchain-mcp-adapters/0.3.2/): API checked against its published wheel, SHA256 `094e6b3096dbcc408417d5722f6915f164772e50c502ae3d8989405bf12c3c84`.
- [LangChain Core 1.6.7](https://pypi.org/project/langchain-core/1.6.7/) and [MCP Python SDK 1.28.1](https://pypi.org/project/mcp/1.28.1/).

Dependencies and adapter source checked on 2026-10-07. No copied framework source is bundled here.
