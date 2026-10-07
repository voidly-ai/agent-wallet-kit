# Read Voidpay services with CrewAI

Call the public `voidpay_services` tool with `{"limit": 1}` through CrewAI's official `MCPServerAdapter`. This example uses **Python 3.12**, an internet connection and no model, API key, Voidly account or wallet.

## Run

From this directory:

```sh
python3.12 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python main.py
```

The script connects to `https://api.voidly.ai/mcp/voidpay`, filters tools to `voidpay_services`, calls `tool.run(limit=1)`, prints the returned text and closes the connection. It creates no Agent or Crew and sends no authentication header. It reads catalog information; it does not purchase a service or register a seller.

The returned text is the tool's current response, not a fixed sample. **This adapter version does not preserve the MCP `isError` flag or structured-content envelope when converting a tool result to text.** The example rejects a returned JSON object containing a gateway `error`, including `INVALID_INPUT`. For multiple content blocks, CrewAI returns a Python representation of a list of JSON strings. The parser uses `ast.literal_eval`, accepts only a list of strings, and checks each JSON string for a gateway error; it never executes returned text. The raw output stays unchanged. Read the returned content: process exit 0 alone is not proof of complete catalog availability. Connection, raised tool errors and recognized gateway errors produce a nonzero exit code. Connection and HTTP timeouts are configured.

## Adapter API

The implementation uses `with MCPServerAdapter(server_params, "voidpay_services", connect_timeout=30) as tools`, followed by the selected tool's `run(limit=1)`. CrewAI names this transport `streamable-http` with a hyphen. The adapter starts during construction; do not call `start()` a second time inside the context manager.

CrewAI 1.15.23 normally serializes omitted optional parameters as `null`. This endpoint rejects null cursors. A serialization subclass scoped to the selected tool uses Pydantic's `exclude_unset=True` while retaining schema validation, so the MCP arguments are exactly `{"limit":1}`. It preserves explicitly supplied null values for schemas that allow them; it does not manufacture a cursor or remove all nulls indiscriminately. The original schema is restored after the call.

Pins: `crewai-tools[mcp]==1.15.23`, `crewai==1.15.23`, `mcpadapt==0.1.20`, `mcp==1.28.1`. MCPAdapt 0.1.20 requires Python 3.12 or newer; this guide uses 3.12. These are direct dependency pins, not a complete transitive lockfile. CrewAI installs dependencies beyond those exercised by this example.

## Offline checks

```sh
.venv/bin/python -m unittest -v test_main.py
```

Tests use CrewAI's actual tool adapter and `run()` with a mocked MCP callback. The complete server input schema reproduces the optional `x402Cursor`/`x402Category` expansion and verifies its correction. Tests also cover explicit null preservation, gateway error JSON, selection and cleanup. They make no gateway or model calls.

## Add a model later

An Agent/Crew can use the selected tool after this connection works. A model-driven workflow needs its chosen provider credentials and may incur provider charges. Keep its tool list restricted to intended operations. The standalone script disables CrewAI telemetry and OpenTelemetry before importing the framework.

## Primary sources

- [CrewAI Streamable HTTP guide](https://docs.crewai.com/v1.15.23/en/mcp/streamable-http) and [MCP adapter installation](https://docs.crewai.com/v1.15.23/en/mcp/overview).
- [CrewAI Tools 1.15.23 release](https://pypi.org/project/crewai-tools/1.15.23/): API and result conversion checked in `crewai_tools/adapters/mcp_adapter.py` from the published wheel, SHA256 `c22409799ce2824d9d99a4190613c69883d6c99677e683a89aa696576a75337e`.
- [MCPAdapt 0.1.20](https://pypi.org/project/mcpadapt/0.1.20/) and [MCP Python SDK 1.28.1](https://pypi.org/project/mcp/1.28.1/).
- [CrewAI telemetry settings](https://docs.crewai.com/v1.15.23/en/telemetry).

Dependencies and adapter source checked on 2026-10-07. No copied framework source is bundled here.
