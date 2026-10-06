"""会话列表与阶段记录：把 task_store 的任务记录与 workspace 里的会话元数据合并成前端可直接展示的视图。"""
import json
import os
from datetime import datetime

from api.db.task_store import ACTIVE, TaskStore

# orchestrator._phase 的阶段号 -> research.checkpoints.PHASES 的键（前端按键翻译阶段名）
PHASE_KEYS = {1: "clarify", 2: "plan", 3: "research", 3.5: "sources", 3.8: "ledger", 4: "analyze", 5: "draft",
              6: "improve", 7: "finish"}


def _read_meta(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as f:
            meta = json.load(f)
    except (OSError, ValueError):
        return {}
    return meta if isinstance(meta, dict) else {}


def _workspaces(workspace_dir: str) -> dict:
    """会话 ID -> (目录名, 目录路径, 元数据)；目录里没有 00_session.json 时元数据为 None。"""
    found: dict[str, tuple[str, str, dict | None]] = {}
    if not os.path.isdir(workspace_dir):
        return found
    for name in os.listdir(workspace_dir):
        path = os.path.join(workspace_dir, name)
        if os.path.isdir(path):
            meta_file = os.path.join(path, "00_session.json")
            meta = _read_meta(meta_file) if os.path.exists(meta_file) else None
            found[name.removeprefix("session_")] = (name, path, meta)
    return found


def _status(task: dict, meta: dict) -> str:
    """有任务记录时以最新任务为准；只有工作空间时，停在中间阶段说明处理它的进程已不在。"""
    if task:
        return "running" if task["status"] in ACTIVE else task["status"]
    raw = meta.get("status")
    if not raw:
        return "unknown"
    return raw if raw in ("completed", "stopped") else "interrupted"


def _entry(session_id: str, task: dict | None, meta: dict | None, fallback_time: str) -> dict:
    task, meta = task or {}, meta or {}
    params = meta.get("resolved_params") or {}
    return {
        "session_id": session_id,
        "task_id": task.get("task_id"),
        "question": (meta.get("question") or task.get("question") or "")[:100],
        "status": _status(task, meta),
        "created_at": meta.get("created_at") or task.get("created_at") or fallback_time,
        "final_score": meta.get("final_score"),
        "total_cycles": meta.get("total_cycles"),
        "depth": params.get("depth") or task.get("depth"),
        # 多模型之前的会话没有这些字段（当时只有 Claude），展示为空
        "provider": meta.get("provider") or params.get("provider") or task.get("provider"),
        "core_model": params.get("core_model") or task.get("core_model"),
        "support_model": params.get("support_model") or task.get("support_model"),
        "language": meta.get("language") or task.get("language") or "zh",  # 报告语言功能之前的研究都是中文
        "current_phase": task.get("phase"),
        "phase_key": PHASE_KEYS.get(task["phase_num"]) if task.get("phase_num") is not None else None,
        "error": task.get("error"),
    }


def list_sessions(store: TaskStore, workspace_dir: str, limit: int, offset: int) -> dict:
    """全部会话（新到旧）。一个会话以其最新的任务为准；会话目录已被删除的任务不再展示；
    没建成工作空间的任务（如启动即失败）单独成项，session_id 为空，用 task_id 标识。"""
    workspaces = _workspaces(workspace_dir)
    latest: dict[str, dict] = {}
    entries = []
    for task in store.list_tasks():  # 新到旧，同一会话先遇到的就是最新任务
        sid = task["session_id"]
        if task["status"] == "deleted":
            continue
        if not sid:
            entries.append(_entry("", task, None, ""))
        elif sid in workspaces:
            latest.setdefault(sid, task)
    for key, (name, path, meta) in workspaces.items():
        if meta is None and key not in latest:
            continue
        mtime = datetime.fromtimestamp(os.path.getmtime(path)).isoformat()
        session_id = meta.get("session_id", name) if meta is not None else key
        entries.append(_entry(session_id, latest.get(key), meta, mtime))
    entries.sort(key=lambda e: e["created_at"], reverse=True)
    return {"sessions": entries[offset:offset + limit], "total": len(entries), "limit": limit, "offset": offset}


def with_phase_keys(tasks: list) -> list:
    return [{**t, "phases": [{**p, "phase_key": PHASE_KEYS.get(p["phase_num"])} for p in t["phases"]]} for t in tasks]
