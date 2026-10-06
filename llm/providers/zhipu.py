"""智谱 GLM：OpenAI 兼容的 chat.completions，流式累积（长生成不会撞单次读超时）。

- 思考：5.3 系列强制开启；强度用顶层 reasoning_effort（low/high/max），经 extra_body 传，按能力表映射。
- 联网：本地工具循环（llm.tools_local）——WebSearch 调智谱 Search API、WebFetch 本机抓取；
  模型一次返回多个 tool_calls 时并行执行；达到 max_turns 仍未给出最终答案即报错。
- 结构化：只有 json_object；schema 写进系统提示词 + 本地 jsonschema 校验，不合格带错误信息重试（最多 2 次）。
  带工具时不传 response_format（与工具调用同用的行为官方未写明）。
- 错误码：1302/1305、5xx、连接错误与流中断退避重试；1113 欠费、1308 达到使用上限按额度错误不重试；
  1301 内容安全拦截不重试。
"""
import asyncio
import functools
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from llm.keys import require_key
from llm.models import ModelSpec, resolve_effort
from llm.providers.openai_common import close_client, is_transient, openai_sdk, to_llm_error
from llm.retry import Sleep, with_backoff
from llm.schema import MAX_REPAIRS, parse_valid, repair_instruction, schema_instruction
from llm.tools_local import FetchFn, SearchFn, ToolRunner, fetch_page, function_tools, zhipu_search
from llm.types import LLMBlockedError, LLMError, LLMPermanentError, LLMRequest, LLMResult
from llm.usage import Usage

BASE_URL = "https://open.bigmodel.cn/api/paas/v4/"
LABEL = "智谱"
QUOTA_CODES = ("1113", "1308")
BLOCKED_CODES = ("1301",)
CHUNK_TIMEOUT = 300  # 流式每个数据块的读超时（秒）；整体超时由 LLMRequest.timeout 控制


def make_client(key: str):
    openai = openai_sdk()
    return openai.AsyncOpenAI(api_key=key, base_url=BASE_URL, timeout=CHUNK_TIMEOUT, max_retries=0,
                              http_client=openai.DefaultAsyncHttpxClient(trust_env=False))  # 国内接口不走系统代理


class _StreamInterrupted(Exception):
    """流式输出以 finish_reason=network_error 结束（可退避重试）"""


@dataclass
class _Reply:
    content: str = ""
    reasoning: str = ""
    tool_slots: dict[int, dict] = field(default_factory=dict)
    finish: str = ""
    usage: Any = None


def _merge_tool_call(slots: dict[int, dict], tc) -> None:
    slot = slots.setdefault(tc.index or 0, {"id": "", "name": "", "arguments": ""})
    slot["id"] = slot["id"] or tc.id or ""
    if tc.function is not None:
        slot["name"] = slot["name"] or tc.function.name or ""
        slot["arguments"] += tc.function.arguments or ""


def _merge(reply: _Reply, chunk) -> None:
    if getattr(chunk, "usage", None):
        reply.usage = chunk.usage
    for choice in chunk.choices or []:
        delta = choice.delta
        if delta is not None:
            reply.content += delta.content or ""
            reply.reasoning += getattr(delta, "reasoning_content", None) or ""
            for tc in delta.tool_calls or []:
                _merge_tool_call(reply.tool_slots, tc)
        reply.finish = choice.finish_reason or reply.finish


def _check_finish(reply: _Reply) -> None:
    if reply.finish == "sensitive":
        raise LLMBlockedError(f"{LABEL} 内容安全拦截（finish_reason=sensitive）")
    if reply.finish == "length":
        raise LLMError(f"{LABEL} 输出达到 max_tokens 上限被截断")
    if reply.finish == "model_context_window_exceeded":
        raise LLMPermanentError(f"{LABEL} 输入超出模型上下文窗口")


def _tool_calls(reply: _Reply) -> list[dict]:
    return [{"id": s["id"] or f"call_{i}", "type": "function",
             "function": {"name": s["name"], "arguments": s["arguments"] or "{}"}}
            for i, s in sorted(reply.tool_slots.items())]


def _assistant_message(reply: _Reply, calls: list[dict]) -> dict:
    """按官方示例原样回传助手消息（含 tool_calls 与思考内容）。"""
    msg: dict[str, Any] = {"role": "assistant", "content": reply.content, "tool_calls": calls}
    if reply.reasoning:
        msg["reasoning_content"] = reply.reasoning
    return msg


def _record(usage: Usage, reply: _Reply) -> None:
    u = reply.usage
    if u is None:
        return
    cached = getattr(getattr(u, "prompt_tokens_details", None), "cached_tokens", 0) or 0
    reasoning = getattr(getattr(u, "completion_tokens_details", None), "reasoning_tokens", 0) or 0
    usage.add_call(u.prompt_tokens or 0, cached, u.completion_tokens or 0, reasoning)


class ZhipuProvider:
    def __init__(self, make_client: Callable[[str], Any] = make_client, sleep: Sleep = asyncio.sleep,
                 search: SearchFn | None = None, fetch: FetchFn | None = None):
        self._make_client = make_client
        self._sleep = sleep
        self._search = search
        self._fetch = fetch

    async def run(self, req: LLMRequest, spec: ModelSpec) -> LLMResult:
        tools = function_tools(req.tools) if req.tools else []
        key = require_key("zhipu")
        openai = openai_sdk()
        client = self._make_client(key)
        runner = ToolRunner(search=self._search or functools.partial(zhipu_search, key, sleep=self._sleep),
                            fetch=self._fetch or fetch_page)
        usage, started = Usage(spec), time.monotonic()
        try:
            text, data = await self._answer(client, req, spec, tools, runner, usage)
        except openai.OpenAIError as e:
            raise to_llm_error(e, LABEL, key, QUOTA_CODES, BLOCKED_CODES) from None
        except _StreamInterrupted:
            raise LLMError(f"{LABEL} 流式输出中断（network_error），退避重试后仍失败") from None
        finally:
            await close_client(client)
        usage.add_local_tools(runner.searches, runner.fetches)
        return LLMResult(text=text, data=data, cost_usd=usage.cost,
                         duration_ms=int((time.monotonic() - started) * 1000), num_turns=usage.calls,
                         session_id="", model_usage=usage.model_usage())

    async def _answer(self, client, req: LLMRequest, spec: ModelSpec, tools: list[dict], runner: ToolRunner,
                      usage: Usage) -> tuple[str, Any]:
        system = req.system + (schema_instruction(req.schema) if req.schema else "")
        messages: list[dict] = [{"role": "system", "content": system}, {"role": "user", "content": req.prompt}]
        for attempt in range(MAX_REPAIRS + 1):
            text = await self._converse(client, req, spec, messages, tools, runner, usage)
            if not req.schema:
                return text, None
            try:
                return text, parse_valid(text, req.schema)
            except ValueError as e:
                if attempt == MAX_REPAIRS:
                    raise LLMError(f"{LABEL} 输出不合格（已重试 {MAX_REPAIRS} 次）：{e}") from None
                messages += [{"role": "assistant", "content": text},
                             {"role": "user", "content": repair_instruction(str(e))}]
        raise AssertionError("unreachable")

    async def _converse(self, client, req: LLMRequest, spec: ModelSpec, messages: list[dict], tools: list[dict],
                        runner: ToolRunner, usage: Usage) -> str:
        """工具循环：执行模型请求的工具并回填结果，直到模型不再调用工具。"""
        for _ in range(req.max_turns):
            reply = await self._chat(client, _params(req, spec, messages, tools), usage)
            if not reply.tool_slots:
                return reply.content
            calls = _tool_calls(reply)
            messages.append(_assistant_message(reply, calls))
            results = await asyncio.gather(*(runner.run(c["function"]["name"], c["function"]["arguments"])
                                             for c in calls))
            messages.extend({"role": "tool", "tool_call_id": c["id"], "content": r}
                            for c, r in zip(calls, results, strict=True))
        raise LLMError(f"{LABEL} 达到 max_turns={req.max_turns} 仍未给出最终答案")

    async def _chat(self, client, params: dict, usage: Usage) -> _Reply:
        async def once() -> _Reply:
            reply = _Reply()
            async for chunk in await client.chat.completions.create(**params):
                _merge(reply, chunk)
            if reply.finish == "network_error":
                raise _StreamInterrupted()
            return reply

        def retryable(e: BaseException) -> bool:
            return isinstance(e, _StreamInterrupted) or is_transient(e, QUOTA_CODES + BLOCKED_CODES)

        reply = await with_backoff(once, retryable, self._sleep, LABEL)
        _record(usage, reply)
        _check_finish(reply)
        return reply


def _params(req: LLMRequest, spec: ModelSpec, messages: list[dict], tools: list[dict]) -> dict:
    extra: dict[str, Any] = {"thinking": {"type": "enabled"}}
    effort = resolve_effort(spec, req.effort)
    if effort:
        extra["reasoning_effort"] = effort
    params: dict[str, Any] = {"model": spec.id, "messages": list(messages), "stream": True, "extra_body": extra}
    if spec.output_budget:
        params["max_tokens"] = spec.output_budget
    if tools:
        params["tools"] = tools
    elif req.schema:
        params["response_format"] = {"type": "json_object"}
    return params
