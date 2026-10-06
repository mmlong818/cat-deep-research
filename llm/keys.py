"""各提供方 API Key：优先取设置页存入系统凭据库的值（api.config_store），环境变量兜底。

任何错误信息都只提字段名与环境变量名，不包含 key 本身。
"""
import os

from llm.types import LLMConfigError

_KEYS = {
    "anthropic": ("anthropic_api_key", "ANTHROPIC_API_KEY", "Anthropic"),
    "openai": ("openai_api_key", "OPENAI_API_KEY", "OpenAI"),
    "zhipu": ("zhipu_api_key", "ZHIPU_API_KEY", "智谱"),
}


def stored_config() -> dict:
    from api.config_store import load_config  # 延迟导入：llm 层不在导入期依赖 api 包
    return load_config()


PROVIDER_KEY = {"claude": "anthropic", "openai": "openai", "zhipu": "zhipu"}  # 配置档的提供方 -> 上面的密钥名


def get_key(provider: str) -> str:
    field, env, _ = _KEYS[provider]
    return stored_config().get(field) or os.environ.get(env, "")


def key_status(name: str, stored: dict | None = None) -> tuple[str, str]:
    """(key, 来源)：来源为 keyring（设置页存入）、env（环境变量）或空串（未配置）。stored 省略时现读。"""
    field, env, _ = _KEYS[name]
    stored_key = (stored if stored is not None else stored_config()).get(field)
    if stored_key:
        return stored_key, "keyring"
    env_key = os.environ.get(env, "")
    return env_key, "env" if env_key else ""


def missing_key_label(provider: str, stored: dict | None = None) -> str | None:
    """配置档的提供方必须有 key 却没配置时返回其显示名；Claude 走订阅（可选 Anthropic key），不要求 key。
    stored 为"假设的已存配置"（设置页提交时用来预判），省略时取当前的。"""
    name = PROVIDER_KEY.get(provider)
    if provider == "claude" or name is None or key_status(name, stored)[0]:
        return None
    return _KEYS[name][2]


def require_key(provider: str) -> str:
    key = get_key(provider)
    if not key:
        field, env, label = _KEYS[provider]
        raise LLMConfigError(f"未配置{label} API Key：请到设置页填写（{field}），或设置环境变量 {env}")
    return key


def redact(text: str, key: str) -> str:
    """去掉错误信息里可能回显的 key（含常见的前后片段）。"""
    if not key:
        return text
    for part in (key, key[:8], key[-6:]):
        if len(part) >= 6:
            text = text.replace(part, "***")
    return text
