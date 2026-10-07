import unittest
from mcp.types import Tool, ToolAnnotations, CallToolResult, TextContent
from main import read_services, MCP_URL, TOOL_NAME, TOOL_ARGUMENTS


class FakeServer:
    def __init__(self, *, missing=False, read_only=True, is_error=False):
        self.missing, self.read_only, self.is_error = missing, read_only, is_error
        self.calls, self.params, self.closed = [], None, False

    def factory(self, **kwargs):
        self.params = kwargs
        return self

    async def __aenter__(self): return self
    async def __aexit__(self, *args): self.closed = True
    async def list_tools(self):
        return [] if self.missing else [Tool(
            name=TOOL_NAME, inputSchema={"type": "object"},
            annotations=ToolAnnotations(readOnlyHint=self.read_only))]
    async def call_tool(self, name, arguments):
        self.calls.append((name, arguments))
        return CallToolResult(content=[TextContent(type="text", text="mocked")], isError=self.is_error)


class QuickstartTests(unittest.IsolatedAsyncioTestCase):
    async def test_exact_read_without_auth_headers_and_cleanup(self):
        server = FakeServer()
        result = await read_services(server.factory)
        self.assertEqual(server.params["params"], {"url": MCP_URL, "timeout": 20})
        self.assertEqual(server.params["max_retry_attempts"], 0)
        self.assertEqual(server.calls, [(TOOL_NAME, TOOL_ARGUMENTS)])
        self.assertTrue(server.closed)
        self.assertFalse(result["isError"])

    async def test_missing_or_non_readonly_tool_is_not_called(self):
        for server in (FakeServer(missing=True), FakeServer(read_only=False)):
            with self.assertRaises(RuntimeError): await read_services(server.factory)
            self.assertEqual(server.calls, [])
            self.assertTrue(server.closed)

    async def test_tool_error_is_not_success(self):
        server = FakeServer(is_error=True)
        with self.assertRaises(RuntimeError): await read_services(server.factory)
        self.assertTrue(server.closed)


if __name__ == "__main__": unittest.main()
