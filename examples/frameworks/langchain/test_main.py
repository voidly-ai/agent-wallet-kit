"""Exercise the real LangChain conversion with a mocked MCP session; no network."""

import os
import unittest
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock

os.environ["LANGSMITH_TRACING"] = "false"
os.environ["LANGCHAIN_TRACING_V2"] = "false"

from mcp.types import CallToolResult, ListToolsResult, TextContent, Tool
from main import MCP_URL, TOOL_NAME, invoke_services


class LangChainQuickstartTests(unittest.IsolatedAsyncioTestCase):
    def setup_client(self, names, *, is_error=False):
        session = AsyncMock()
        session.list_tools.return_value = ListToolsResult(tools=[
            Tool(name=name, description="Dummy offline tool", inputSchema={
                "type": "object", "properties": {"limit": {"type": "integer"}},
                "required": ["limit"], "additionalProperties": False,
            }) for name in names
        ])
        session.call_tool.return_value = CallToolResult(
            content=[TextContent(type="text", text='{"fixture":true}')], isError=is_error)
        events = []

        class FakeClient:
            def __init__(self, configuration):
                events.append(configuration)

            @asynccontextmanager
            async def session(self, name):
                events.append(("enter", name))
                try:
                    yield session
                finally:
                    events.append(("exit", name))

        return FakeClient, session, events

    async def test_only_named_read_tool_with_exact_arguments(self):
        factory, session, events = self.setup_client(["do_not_call", TOOL_NAME])
        result = await invoke_services(client_factory=factory)
        self.assertEqual(events[0]["voidpay"]["url"], MCP_URL)
        self.assertEqual(events[0]["voidpay"]["transport"], "streamable_http")
        self.assertNotIn("headers", events[0]["voidpay"])
        session.call_tool.assert_awaited_once()
        self.assertEqual(session.call_tool.call_args.args, (TOOL_NAME, {"limit": 1}))
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["type"], "text")
        self.assertEqual(result[0]["text"], '{"fixture":true}')
        self.assertEqual(events[-1], ("exit", "voidpay"))

    async def test_missing_tool_refused_without_call(self):
        factory, session, events = self.setup_client(["do_not_call"])
        with self.assertRaisesRegex(RuntimeError, "exactly one"):
            await invoke_services(client_factory=factory)
        session.call_tool.assert_not_awaited()
        self.assertEqual(events[-1], ("exit", "voidpay"))

    async def test_duplicate_tool_refused_without_call(self):
        factory, session, _ = self.setup_client([TOOL_NAME, TOOL_NAME])
        with self.assertRaisesRegex(RuntimeError, "exactly one"):
            await invoke_services(client_factory=factory)
        session.call_tool.assert_not_awaited()

    async def test_mcp_tool_error_propagates_and_session_closes(self):
        from langchain_core.tools import ToolException
        factory, _, events = self.setup_client([TOOL_NAME], is_error=True)
        with self.assertRaises(ToolException):
            await invoke_services(client_factory=factory)
        self.assertEqual(events[-1], ("exit", "voidpay"))


if __name__ == "__main__":
    unittest.main()
