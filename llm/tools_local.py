"""本地联网工具：给没有托管联网能力的模型（智谱 GLM）在工具循环中调用。

WebSearch 调智谱 Web Search API，WebFetch 在本机抓取网页并用标准库提取正文。
工具名与 Claude Code 内置工具同名，智能体提示词里的 WebSearch / WebFetch 无需改动。
工具失败以 {"error": ...} 交回模型，不中断整个调用。
"""
import asyncio
import functools
import ipaddress
import json
import re
import socket
from collections.abc import Awaitable, Callable
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse

import requests  # type: ignore[import-untyped]  # 未安装 types-requests 存根

from llm.retry import Sleep, with_backoff
from llm.types import LLMConfigError

ZHIPU_SEARCH_URL = "https://open.bigmodel.cn/api/paas/v4/web_search"
SEARCH_ENGINE = "search_pro"
SEARCH_QUERY_MAX = 70
SEARCH_COUNT_MAX = 20
SEARCH_SNIPPET_CHARS = 800
RECENCY = ("oneDay", "oneWeek", "oneMonth", "oneYear", "noLimit")
FETCH_DEFAULT_CHARS = 6000
FETCH_MAX_CHARS = 20000
FETCH_TIMEOUT = 20
MAX_DOWNLOAD_BYTES = 3_000_000
MAX_REDIRECTS = 5
_UA = "Mozilla/5.0 (compatible; CatResearch/2.0)"

SearchFn = Callable[[str, int, str], Awaitable[dict]]
FetchFn = Callable[[str, int], Awaitable[dict]]

TOOL_SPECS = {
    "WebSearch": {"type": "function", "function": {
        "name": "WebSearch",
        "description": "联网搜索网页，返回标题、链接、摘要与发布日期。需要细节时再用 WebFetch 打开链接阅读全文。",
        "parameters": {"type": "object", "properties": {
            "query": {"type": "string", "description": f"搜索词，不超过 {SEARCH_QUERY_MAX} 个字符"},
            "count": {"type": "integer", "description": f"返回条数 1-{SEARCH_COUNT_MAX}，默认 8"},
            "recency": {"type": "string", "enum": list(RECENCY), "description": "时间范围，默认 noLimit"},
        }, "required": ["query"]},
    }},
    "WebFetch": {"type": "function", "function": {
        "name": "WebFetch",
        "description": "打开一个公网 http(s) 网页并提取正文文本；超长时截断，并注明原始长度。",
        "parameters": {"type": "object", "properties": {
            "url": {"type": "string", "description": "网页地址"},
            "max_chars": {"type": "integer",
                          "description": f"最多返回的字符数，默认 {FETCH_DEFAULT_CHARS}，上限 {FETCH_MAX_CHARS}"},
        }, "required": ["url"]},
    }},
}


def function_tools(names) -> list[dict]:
    unknown = [n for n in names if n not in TOOL_SPECS]
    if unknown:
        raise LLMConfigError(f"本地工具循环不支持工具：{', '.join(unknown)}（可用：{', '.join(TOOL_SPECS)}）")
    return [TOOL_SPECS[n] for n in names]


# ── 网页正文提取 ──────────────────────────────────────────────────────────────

_SKIP = {"script", "style", "noscript", "nav", "footer", "header", "svg", "template", "iframe", "form"}
_BLOCK = {"p", "div", "br", "li", "tr", "section", "article", "table", "ul", "ol", "blockquote", "pre",
          "h1", "h2", "h3", "h4", "h5", "h6", "title"}


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in _SKIP:
            self.skip += 1
        elif tag in _BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in _SKIP:
            self.skip = max(self.skip - 1, 0)
        elif tag in _BLOCK:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)


def extract_text(html: str) -> str:
    parser = _TextExtractor()
    parser.feed(html)
    parser.close()
    lines = (" ".join(line.split()) for line in "".join(parser.parts).splitlines())
    return "\n".join(line for line in lines if line)


# ── 抓取（只允许公网地址，防止被网页内容诱导访问本机或内网服务）────────────────

def _resolves_public(host: str) -> bool:
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        return True  # 解析失败时由请求本身报错
    return all(ipaddress.ip_address(info[4][0]).is_global for info in infos)


def is_public_url(url: str, resolve: Callable[[str], bool] = _resolves_public) -> bool:
    parts = urlparse(url)
    host = (parts.hostname or "").lower()
    if parts.scheme not in ("http", "https") or not host or host == "localhost" or host.endswith(".localhost"):
        return False
    try:
        return ipaddress.ip_address(host).is_global
    except ValueError:
        return resolve(host)


def _decode(raw: bytes, resp: requests.Response) -> str:
    header = resp.headers.get("content-type", "").lower()
    match = re.search(rb"charset=[\"']?([\w-]+)", raw[:4096])
    encoding = resp.encoding if "charset" in header else (match.group(1).decode() if match else "utf-8")
    try:
        return raw.decode(encoding or "utf-8", errors="replace")
    except LookupError:
        return raw.decode("utf-8", errors="replace")


def _hop(session: requests.Session, url: str) -> tuple[int, str, str] | str:
    """请求一跳：重定向时返回目标地址，否则返回 (状态码, 内容类型, 正文)；只读取前 MAX_DOWNLOAD_BYTES 字节。"""
    with session.get(url, headers={"User-Agent": _UA}, timeout=FETCH_TIMEOUT,
                     allow_redirects=False, stream=True) as resp:
        if resp.is_redirect:
            return urljoin(url, resp.headers.get("location", ""))
        raw = resp.raw.read(MAX_DOWNLOAD_BYTES, decode_content=True)
        return resp.status_code, resp.headers.get("content-type", ""), _decode(raw, resp)


def _http_get(url: str, check: Callable[[str], bool]) -> tuple[int, str, str]:
    """逐跳跟随重定向，每一跳都重新检查是否公网地址。"""
    with requests.Session() as session:
        for _ in range(MAX_REDIRECTS + 1):
            if not check(url):
                raise ValueError(f"拒绝访问非公网地址：{url}")
            result = _hop(session, url)
            if not isinstance(result, str):
                return result
            url = result
    raise ValueError("重定向次数过多")


async def fetch_page(url: str, max_chars: int = FETCH_DEFAULT_CHARS, *,
                     get: Callable[[str], tuple[int, str, str]] | None = None,
                     check: Callable[[str], bool] = is_public_url) -> dict:
    if not await asyncio.to_thread(check, url):
        return {"url": url, "error": "只能抓取公网 http(s) 地址"}
    getter = get or functools.partial(_http_get, check=check)
    try:
        status, content_type, body = await asyncio.to_thread(getter, url)
    except (requests.RequestException, ValueError) as e:
        return {"url": url, "error": f"抓取失败：{type(e).__name__}: {e}"}
    if status >= 400:
        return {"url": url, "error": f"HTTP {status}"}
    if content_type and not any(t in content_type for t in ("html", "text", "xml", "json")):
        return {"url": url, "error": f"不支持的内容类型：{content_type}"}
    text = extract_text(body) if "html" in content_type or not content_type else body.strip()
    return {"url": url, "text": text[:max_chars], "original_chars": len(text),
            "returned_chars": min(len(text), max_chars), "truncated": len(text) > max_chars}


# ── 智谱 Web Search API ──────────────────────────────────────────────────────

class _Transient(Exception):
    """可退避重试的搜索失败（429 / 并发超限 / 5xx）"""


def _http_post(url: str, headers: dict, payload: dict) -> tuple[int, dict]:
    with requests.Session() as session:
        session.trust_env = False  # 国内接口不走系统代理
        resp = session.post(url, headers=headers, json=payload, timeout=30)
    try:
        return resp.status_code, resp.json()
    except ValueError:
        return resp.status_code, {"error": {"message": resp.text[:200]}}


def _describe(status: int, body: dict) -> str:
    err = body.get("error") or {}
    return f"HTTP {status} code={err.get('code', '')} {err.get('message', '')}".strip()


def _trim(item: dict) -> dict:
    out = {k: item.get(k) for k in ("title", "link", "media", "publish_date")}
    out["content"] = (item.get("content") or "")[:SEARCH_SNIPPET_CHARS]
    return {k: v for k, v in out.items() if v not in (None, "")}


async def zhipu_search(key: str, query: str, count: int = 8, recency: str = "noLimit", *,
                       post: Callable[[str, dict, dict], tuple[int, dict]] | None = None,
                       sleep: Sleep = asyncio.sleep) -> dict:
    payload = {"search_query": query[:SEARCH_QUERY_MAX], "search_engine": SEARCH_ENGINE,
               "count": min(max(count, 1), SEARCH_COUNT_MAX),
               "search_recency_filter": recency if recency in RECENCY else "noLimit"}
    headers = {"Authorization": f"Bearer {key}"}
    poster = post or _http_post

    async def once() -> tuple[int, dict]:
        status, body = await asyncio.to_thread(poster, ZHIPU_SEARCH_URL, headers, payload)
        if status == 429 or status >= 500:
            raise _Transient(_describe(status, body))
        return status, body

    try:
        status, body = await with_backoff(once, lambda e: isinstance(e, _Transient), sleep, "智谱搜索")
    except _Transient as e:
        return {"error": f"搜索暂时不可用（已退避重试）：{e}"}
    except requests.RequestException as e:
        return {"error": f"搜索请求失败：{type(e).__name__}"}
    if status != 200:
        return {"error": f"搜索失败：{_describe(status, body)}"}
    return {"results": [_trim(i) for i in body.get("search_result") or []]}


# ── 工具分发 ─────────────────────────────────────────────────────────────────

def _int(value, default: int) -> int:
    try:
        return max(int(value), 1)
    except (TypeError, ValueError):
        return default


class ToolRunner:
    """执行模型请求的工具调用，返回交给模型的 JSON 文本；记录成功的搜索/抓取次数（计费用）。"""

    def __init__(self, search: SearchFn, fetch: FetchFn):
        self._search, self._fetch = search, fetch
        self.searches = 0
        self.fetches = 0

    async def run(self, name: str, arguments: str) -> str:
        try:
            args = json.loads(arguments or "{}")
        except json.JSONDecodeError:
            args = None
        if not isinstance(args, dict):
            out = {"error": "工具参数不是合法的 JSON 对象"}
        elif name == "WebSearch":
            out = await self._run_search(args)
        elif name == "WebFetch":
            out = await self._run_fetch(args)
        else:
            out = {"error": f"未知工具：{name}"}
        return json.dumps(out, ensure_ascii=False)

    async def _run_search(self, args: dict) -> dict:
        query = str(args.get("query") or "").strip()
        if not query:
            return {"error": "缺少 query 参数"}
        out = await self._search(query, _int(args.get("count"), 8), str(args.get("recency") or "noLimit"))
        self.searches += "error" not in out
        return out

    async def _run_fetch(self, args: dict) -> dict:
        url = str(args.get("url") or "").strip()
        if not url:
            return {"error": "缺少 url 参数"}
        out = await self._fetch(url, min(_int(args.get("max_chars"), FETCH_DEFAULT_CHARS), FETCH_MAX_CHARS))
        self.fetches += "error" not in out
        return out
