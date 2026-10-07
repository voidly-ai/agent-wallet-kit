"""Invoke one public Voidpay MCP tool through LangChain, without an LLM."""

import asyncio
import json
import os
import sys
from datetime import timedelta


MCP_URL = "https://api.voidly.ai/mcp/voidpay"
TOOL_NAME = "voidpay_services"


async def invoke_services(*, client_factory=None, tool_loader=None):
    """Use an initialized adapter session and call only the named read tool."""
    if client_factory is None:
        from langchain_mcp_adapters.client import MultiServerMCPClient
        client_factory = MultiServerMCPClient
    if tool_loader is None:
        from langchain_mcp_adapters.tools import load_mcp_tools
        tool_loader = load_mcp_tools

    client = client_factory({
        "voidpay": {
            "url": MCP_URL,
            "transport": "streamable_http",
            "timeout": 30.0,
            "sse_read_timeout": 30.0,
            "session_kwargs": {"read_timeout_seconds": timedelta(seconds=30)},
        }
    })
    # MultiServerMCPClient itself is not an async context manager.
    async with client.session("voidpay") as session:
        tools = await tool_loader(session, handle_tool_errors=False)
        matches = [tool for tool in tools if tool.name == TOOL_NAME]
        if len(matches) != 1:
            raise RuntimeError(f"Expected exactly one {TOOL_NAME} tool; found {len(matches)}")
        return await matches[0].ainvoke({"limit": 1})


def main():
    # Keep this standalone example out of inherited LangSmith tracing settings.
    os.environ["LANGSMITH_TRACING"] = "false"
    os.environ["LANGCHAIN_TRACING_V2"] = "false"
    try:
        result = asyncio.run(asyncio.wait_for(invoke_services(), timeout=45))
    except Exception as exc:
        print(f"Voidpay read failed ({type(exc).__name__}): {exc}", file=sys.stderr)
        return 1
    print(json.dumps({"tool": TOOL_NAME, "arguments": {"limit": 1}, "result": result},
                     ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
