"""Exercise the real CrewAI tool conversion with a mocked MCP callback."""

import os
import copy
import unittest
from unittest.mock import Mock

os.environ["CREWAI_DISABLE_TELEMETRY"] = "true"
os.environ["OTEL_SDK_DISABLED"] = "true"

from crewai_tools.adapters.mcp_adapter import CrewAIToolAdapter
from mcp.types import CallToolResult, TextContent, Tool
from main import MCP_URL, TOOL_NAME, invoke_services, run_explicit_arguments


# Complete voidpay_services input schema at source 0d02a506,
# worker/src/routes/voidpayMcp.ts:43-62. Optional does not mean nullable.
DIGEST = {"type": "string", "pattern": "^[0-9a-f]{64}$"}
SERVICES_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": [],
    "properties": {
        "limit": {"type": "integer", "minimum": 1, "maximum": 10},
        "cursor": DIGEST,
        "search": {"type": "string", "minLength": 1, "maxLength": 80},
        "query": {
            "type": "object", "additionalProperties": False,
            "properties": {
                "limit": {"type": "integer", "minimum": 1, "maximum": 10},
                "after": DIGEST, "definitionDigest": DIGEST,
            },
        },
        "x402Cursor": {"type": "string", "minLength": 8, "maxLength": 512,
                       "pattern": "^[A-Za-z0-9_-]{8,512}$"},
        "x402Category": {"type": "string", "minLength": 1, "maxLength": 64},
    },
}


class CrewAIQuickstartTests(unittest.TestCase):
    def setup_adapter(self, names, *, is_error=False, text='{"fixture":true}', texts=None):
        callback = Mock(return_value=CallToolResult(
            content=[TextContent(type="text", text=chunk) for chunk in (texts if texts is not None else [text])],
            isError=is_error))
        tools = [CrewAIToolAdapter().adapt(callback, Tool(
            name=name, description="Dummy offline tool", inputSchema=copy.deepcopy(SERVICES_SCHEMA)))
            for name in names]
        events = []

        class FakeAdapter:
            def __init__(self, parameters, *tool_names, connect_timeout):
                events.append((parameters, tool_names, connect_timeout))

            def __enter__(self):
                return tools

            def __exit__(self, *exc):
                events.append("closed")

        return FakeAdapter, callback, events

    def test_only_named_read_tool_with_exact_arguments(self):
        factory, callback, events = self.setup_adapter(["do_not_call", TOOL_NAME])
        self.assertEqual(invoke_services(adapter_factory=factory), '{"fixture":true}')
        parameters, names, timeout = events[0]
        self.assertEqual(parameters["url"], MCP_URL)
        self.assertEqual(parameters["transport"], "streamable-http")
        self.assertNotIn("headers", parameters)
        self.assertEqual(names, (TOOL_NAME,))
        self.assertEqual(timeout, 30)
        callback.assert_called_once_with({"limit": 1})
        self.assertEqual(events[-1], "closed")

    def test_missing_or_duplicate_tool_refused(self):
        for names in (["do_not_call"], [TOOL_NAME, TOOL_NAME]):
            with self.subTest(names=names):
                factory, callback, events = self.setup_adapter(names)
                with self.assertRaisesRegex(RuntimeError, "exactly one"):
                    invoke_services(adapter_factory=factory)
                callback.assert_not_called()
                self.assertEqual(events[-1], "closed")

    def test_transport_error_propagates_and_adapter_closes(self):
        factory, callback, events = self.setup_adapter([TOOL_NAME])
        callback.side_effect = RuntimeError("mock transport error")
        with self.assertRaisesRegex(RuntimeError, "mock transport"):
            invoke_services(adapter_factory=factory)
        self.assertEqual(events[-1], "closed")

    def test_adapter_returns_error_text_without_success_label(self):
        # Upstream adapter drops isError. Preserve the output; do not call it success.
        factory, callback, _ = self.setup_adapter([TOOL_NAME], is_error=True)
        self.assertEqual(invoke_services(adapter_factory=factory), '{"fixture":true}')
        callback.assert_called_once_with({"limit": 1})

    def test_upstream_reproduction_inserts_unset_null_fields(self):
        callback = Mock(return_value=CallToolResult(content=[TextContent(type="text", text="{}")]))
        tool = CrewAIToolAdapter().adapt(callback, Tool(
            name=TOOL_NAME, inputSchema=copy.deepcopy(SERVICES_SCHEMA)))
        tool.run(limit=1)
        self.assertEqual(callback.call_args.args[0], {
            "limit": 1, "cursor": None, "search": None, "query": None,
            "x402Cursor": None, "x402Category": None,
        })

    def test_explicit_null_is_not_silently_removed(self):
        callback = Mock(return_value=CallToolResult(content=[TextContent(type="text", text="{}")]))
        tool = CrewAIToolAdapter().adapt(callback, Tool(name=TOOL_NAME, inputSchema={
            "type": "object", "properties": {
                "limit": {"type": "integer"},
                "optional": {"anyOf": [{"type": "string"}, {"type": "null"}]},
                "absent": {"type": "string"},
            }, "required": ["limit"],
        }))
        original_schema = tool.args_schema
        run_explicit_arguments(tool, {"limit": 1, "optional": None})
        callback.assert_called_once_with({"limit": 1, "optional": None})
        self.assertIs(tool.args_schema, original_schema)

    def test_returned_gateway_error_json_fails(self):
        factory, callback, events = self.setup_adapter([TOOL_NAME], is_error=True,
            text='{"error":{"code":"INVALID_INPUT","field":"x402Cursor"},"provider":"Voidpay · voidly.ai"}')
        with self.assertRaisesRegex(RuntimeError, "INVALID_INPUT"):
            invoke_services(adapter_factory=factory)
        callback.assert_called_once_with({"limit": 1})
        self.assertEqual(events[-1], "closed")

    def test_multi_content_gateway_error_chunk_fails(self):
        factory, callback, events = self.setup_adapter([TOOL_NAME], texts=[
            '{"fixture":true}',
            '{"error":{"code":"PUBLIC_READ_UNAVAILABLE"},"provider":"Voidpay · voidly.ai"}',
        ])
        with self.assertRaisesRegex(RuntimeError, "PUBLIC_READ_UNAVAILABLE"):
            invoke_services(adapter_factory=factory)
        callback.assert_called_once_with({"limit": 1})
        self.assertEqual(events[-1], "closed")

    def test_multi_content_output_is_preserved(self):
        chunks = ['{"fixture":true}', '{"availability":"unavailable"}']
        factory, callback, _ = self.setup_adapter([TOOL_NAME], texts=chunks)
        self.assertEqual(invoke_services(adapter_factory=factory), str(chunks))
        callback.assert_called_once_with({"limit": 1})

    def test_literal_parser_restricts_repr_to_list_of_strings(self):
        for text in ("[{'error': {'code': 'NOT_JSON'}}]", "__import__('os').getcwd()"):
            with self.subTest(text=text):
                factory, callback, _ = self.setup_adapter([TOOL_NAME], text=text)
                self.assertEqual(invoke_services(adapter_factory=factory), text)
                callback.assert_called_once_with({"limit": 1})


if __name__ == "__main__":
    unittest.main()
