"""
设置 API：默认配置档（提供方 + 核心/辅助模型）与各提供方的 API Key。
key 只存系统凭据库，接口里只返回"是否已配置 + 末 4 位预览"。
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from llm import keys
from llm.models import MODELS
from llm.profiles import PROFILES, default_profile

from ..config_store import SecretStoreUnavailable, load_config, save_config
from ..profile_resolver import missing_key_detail, validate_profile

router = APIRouter(prefix="/api/settings", tags=["settings"])


class ProfileIn(BaseModel):
    provider: str
    core: str | None = None      # 不传取该提供方默认
    support: str | None = None


class SettingsUpdate(BaseModel):
    default_profile: ProfileIn | None = None
    api_keys: dict[str, str] = Field(default_factory=dict)   # 提供方 -> key；空字符串表示不改
    clear_keys: list[str] = Field(default_factory=list)      # 要删除 key 的提供方


def _tier(output_price: float) -> str:
    """按输出价（美元/百万 token）粗分价格档，供界面提示。"""
    return "low" if output_price < 2 else "mid" if output_price < 15 else "high"


def models_by_provider() -> dict[str, list[dict]]:
    """能力表里的模型按提供方分组（顺序同注册表）。"""
    grouped: dict[str, list[dict]] = {p: [] for p in PROFILES}
    for spec in MODELS.values():
        grouped[spec.provider].append({
            "id": spec.id, "tier": _tier(spec.output_price), "input_price": spec.input_price,
            "cached_price": spec.cached_price, "output_price": spec.output_price, "context": spec.context,
        })
    return grouped


def _secret_field(provider: str) -> str:
    if provider not in PROFILES:
        raise HTTPException(status_code=400, detail=f"未知提供方 {provider!r}（可选：{', '.join(PROFILES)}）")
    return f"{keys.PROVIDER_KEY[provider]}_api_key"


def settings_view() -> dict:
    stored = load_config()
    grouped = models_by_provider()
    providers = {}
    for provider, base in PROFILES.items():
        key, source = keys.key_status(keys.PROVIDER_KEY[provider], stored)
        needs_key = provider != "claude"   # Claude 走订阅（claude-agent-sdk），Anthropic key 只是可选的 API 模式
        providers[provider] = {
            "needs_key": needs_key, "has_key": bool(key), "key_source": source,
            "key_preview": f"...{key[-4:]}" if len(key) > 4 else "",
            "available": bool(key) or not needs_key,
            "defaults": {"core": base.core, "support": base.support},
            "models": grouped[provider],
        }
    current = default_profile()
    return {"default_profile": {"provider": current.provider, "core": current.core, "support": current.support},
            "providers": providers}


@router.get("")
def get_settings():
    return settings_view()


@router.post("")
def update_settings(body: SettingsUpdate):
    updates: dict = {_secret_field(p): "" for p in body.clear_keys}
    updates.update({_secret_field(p): v.strip() for p, v in body.api_keys.items() if v.strip()})
    if body.default_profile:
        profile = validate_profile(body.default_profile.provider, body.default_profile.core,
                                   body.default_profile.support)
        label = keys.missing_key_label(profile.provider, {**load_config(), **updates})  # 同一请求里一并提交的 key 也算
        if label:
            raise HTTPException(status_code=400, detail=missing_key_detail(label))
        updates["default_profile"] = {"provider": profile.provider, "core": profile.core, "support": profile.support}
    _save(updates)
    return settings_view()


@router.delete("/keys/{provider}")
def clear_key(provider: str):
    _save({_secret_field(provider): ""})
    return settings_view()


def _save(updates: dict):
    try:
        save_config(updates)
    except SecretStoreUnavailable as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
