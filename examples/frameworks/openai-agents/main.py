"""One public read using the OpenAI Agents SDK's hosted MCP adapter.

No LLM request, OpenAI key, Voidly key, wallet, signature or payment is used.
"""
from __future__ import annotations
import asyncio
import json
from agents import set_tracing_disabled
from agents.mcp import MCPServerStreamableHttp

MCP_URL = "https://api.voidly.ai/mcp/voidpay"
TOOL_NAME = "voidpay_services"
TOOL_ARGUMENTS = {"limit": 1}


async def read_services(server_factory=MCPServerStreamableHttp) -> dict:
    # No tracing exporter or model request is needed for this direct tool call.
    set_tracing_disabled(True)
    async with server_factory(
        name="Voidly public services",
        params={"url": MCP_URL, "timeout": 20},
        client_session_timeout_seconds=20,
        max_retry_attempts=0,
        tool_filter={"allowed_tool_names": [TOOL_NAME]},
    ) as server:
        tools = await server.list_tools()
        selected = next((tool for tool in tools if tool.name == TOOL_NAME), None)
        if selected is None:
            raise RuntimeError("The hosted server did not advertise voidpay_services")
        if selected.annotations is None or selected.annotations.model_dump(by_alias=True).get("readOnlyHint") is not True:
            raise RuntimeError("The selected tool is not advertised as read-only")
        result = await server.call_tool(TOOL_NAME, TOOL_ARGUMENTS)
        wire_result = result.model_dump(mode="json", by_alias=True, exclude_none=True)
        if wire_result.get("isError"):
            raise RuntimeError("The hosted tool reported an error; no model or payment was attempted")
        return wire_result


async def main() -> None:
    result = await read_services()
    print(json.dumps({"endpoint": MCP_URL, "tool": TOOL_NAME, "result": result}, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
