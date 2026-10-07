"""Invoke one public Voidpay MCP tool through CrewAI, without an LLM."""

import ast
import json
import os
import sys


MCP_URL = "https://api.voidly.ai/mcp/voidpay"
TOOL_NAME = "voidpay_services"


def run_explicit_arguments(tool, arguments):
    """Keep CrewAI validation, without adding absent MCP parameters as null.

    CrewAI 1.15.23 BaseTool.run serializes its validated model with model_dump().
    Scope the serialization correction to this selected tool, then restore it.
    exclude_unset preserves explicitly supplied None where the schema permits it.
    """
    original_schema = tool.args_schema

    class ExplicitArguments(original_schema):
        def model_dump(self, *args, **kwargs):
            kwargs["exclude_unset"] = True
            return super().model_dump(*args, **kwargs)

    tool.args_schema = ExplicitArguments
    try:
        return tool.run(**arguments)
    finally:
        tool.args_schema = original_schema


def reject_gateway_error(result):
    """Recover the gateway's explicit JSON error signal from adapter text."""
    if not isinstance(result, str):
        return
    try:
        value = json.loads(result)
    except (ValueError, RecursionError):
        # CrewAI 1.15.23 represents multiple content blocks with str(list[str]).
        # literal_eval accepts literals only; never execute adapter-returned text.
        try:
            value = ast.literal_eval(result)
        except (ValueError, SyntaxError, RecursionError):
            return
        if not isinstance(value, list) or not all(isinstance(chunk, str) for chunk in value):
            return
    if isinstance(value, list) and all(isinstance(chunk, str) for chunk in value):
        chunks = []
        for chunk in value:
            try:
                chunks.append(json.loads(chunk))
            except (ValueError, RecursionError):
                continue
    else:
        chunks = [value]
    for chunk in chunks:
        if isinstance(chunk, dict) and chunk.get("error") is not None:
            error = chunk["error"]
            code = error.get("code", "UNKNOWN") if isinstance(error, dict) else "UNKNOWN"
            raise RuntimeError(f"Voidpay returned a gateway error: {code}")


def invoke_services(*, adapter_factory=None):
    """Call a filtered official MCP adapter tool directly; create no Agent/Crew."""
    if adapter_factory is None:
        from crewai_tools import MCPServerAdapter
        from crewai_tools.adapters.mcp_adapter import MCP_AVAILABLE
        if not MCP_AVAILABLE:
            # The adapter otherwise offers an interactive dependency install.
            raise RuntimeError("Install requirements.txt first; MCP dependencies are unavailable")
        adapter_factory = MCPServerAdapter

    server = {
        "url": MCP_URL,
        "transport": "streamable-http",
        "timeout": 30.0,
        "sse_read_timeout": 30.0,
    }
    with adapter_factory(server, TOOL_NAME, connect_timeout=30) as tools:
        matches = [tool for tool in tools if tool.name == TOOL_NAME]
        if len(matches) != 1:
            raise RuntimeError(f"Expected exactly one {TOOL_NAME} tool; found {len(matches)}")
        # CrewAI's MCP adapter returns tool text, not the full MCP result envelope.
        result = run_explicit_arguments(matches[0], {"limit": 1})
        reject_gateway_error(result)
        return result


def main():
    # Set before importing CrewAI; no Crew, model or tracing service is needed.
    os.environ["CREWAI_DISABLE_TELEMETRY"] = "true"
    os.environ["OTEL_SDK_DISABLED"] = "true"
    try:
        result = invoke_services()
    except Exception as exc:
        print(f"Voidpay read failed ({type(exc).__name__}): {exc}", file=sys.stderr)
        return 1
    print(json.dumps({"tool": TOOL_NAME, "arguments": {"limit": 1}, "result": result},
                     ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
