"""
ResearchOrchestrator - 研究协调器
统一协调所有智能体的工作，管理完整的研究流程：
规划 → 研究 → 来源验证 → 声明台账（对账 + 事实核查）→ 分析 → 初稿
→ 评审/结论验证/补充研究（+对账裁决）/改写循环 → 置信度报告
改进循环的停止与最优稿选择见 research.loop_policy，声明台账见 research.ledger。
"""
import json
import os
import sys
import time
from collections.abc import Callable
from dataclasses import asdict
from datetime import datetime
from typing import Any

# Windows GBK 控制台 emoji 兼容（reconfigure 原地修改；重新包装 buffer 会在旧包装被回收时关闭它）
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)

import config as _config
from agents.analyst import AnalystAgent
from agents.conclusion_validator import ConclusionValidatorAgent
from agents.critic import CriticAgent
from agents.fact_checker import FactCheckerAgent
from agents.llm_agent import ResearchStopped, read_text
from agents.planner import PlannerAgent, key_entities_of
from agents.reconciler import ReconcilerAgent
from agents.researcher import ResearcherAgent
from agents.source_verifier import SourceVerifierAgent
from agents.writer import WriterAgent
from config import WORKSPACE_DIR  # 模型与循环参数在运行时读取 _config.*（API 可在运行中修改）
from llm import LLMError
from llm.profiles import Profile, default_profile
from research.checkpoints import PHASES, Checkpoints, params_hash
from research.confidence import combine, component_scores, level
from research.ledger import (
    QUALITY_HEADINGS,
    VIOLATIONS_HEADINGS,
    Ledger,
    format_violations,
    heading_for,
    with_references,
)
from research.loop_ask import LoopAsk
from research.loop_policy import LoopPolicy, LoopState, pick_final, stop_reason
from research.params import resolve_cycles, resolve_params
from tools.file_tools import (
    WorkspaceDeleted,
    append_to_log,
    is_workspace_deleted,
    read_json,
    write_file,
    write_json,
)

MIN_RESEARCH_BYTES = 1000   # 首轮研究内容低于此值视为失败，触发重试

INTENT_STRATEGY_HINT = {
    "info_seeking":    "综合信息汇总，注重广度和来源多样性，覆盖主流观点与最新动态",
    "problem_solving": "聚焦问题根因与解决路径，注重深度分析，优先找到可执行的答案",
    "exploration":     "开放式探索，鼓励发现新方向与潜在机会，不限于已知框架",
    "optimization":    "多方案横向对比评估，注重客观数据与实测结果，找出最优选择",
    "task_completion": "产出结构化、可直接使用的成果，注重实用性和完整性",
}

DIM_NAMES = {"completeness": "完整性", "accuracy": "准确性", "depth": "分析深度",
             "clarity": "逻辑清晰度", "usefulness": "实用价值", "sources": "信息来源",
             "simplicity": "简洁性"}


class _Interrupted(Exception):
    """检查点收到停止/暂停超时"""


def _pct(v, na: str = "N/A（未完成）") -> str:
    return f"{v:.0%}" if isinstance(v, (int, float)) else na


# 研究质量报告附录里的固定文字（随报告语言；标题见 research.ledger.QUALITY_HEADINGS）
QUALITY_TEXT = {
    "zh": {"na": "N/A（未完成）", "dimension": "维度", "score": "评分", "overall": "综合置信度",
           "source": "来源质量", "fact": "事实准确度", "conclusion": "结论有效性", "rounds": "评审轮数",
           "final": "最终评审分", "rounds_value": "{n} 轮", "final_value": "{score:.1f}/10（第 {draft} 版）",
           "footer": "本报告由多智能体研究系统自动生成，包含来源验证、事实核查和结论验证流程"},
    "en": {"na": "N/A (incomplete)", "dimension": "Dimension", "score": "Score", "overall": "Overall confidence",
           "source": "Source quality", "fact": "Fact accuracy", "conclusion": "Conclusion validity",
           "rounds": "Review rounds", "final": "Final review score", "rounds_value": "{n}",
           "final_value": "{score:.1f}/10 (draft {draft})",
           "footer": "This report was generated automatically by a multi-agent research system, "
                     "including source verification, fact checking and conclusion validation"},
}


class ResearchOrchestrator:
    """多智能体研究系统主协调器（接口供 main.py 与 api/app.py 使用）"""

    def __init__(self, progress_callback: Callable | None = None, profile: Profile | None = None):
        self.profile = profile or default_profile()  # 本任务的模型配置档；不传时取当前 config（不改全局变量）
        self.workspace: str | None = None
        self.session_id: str | None = None
        self.log_file: str | None = None
        self.progress_callback = progress_callback  # API 模式下的进度回调
        self._user_messages: list[str] = []          # 用户中途注入的消息列表（api/app.py 直接追加）
        self._pause_event = None          # threading.Event，None=不暂停，clear=暂停中
        self._stop_event = None           # threading.Event，set=立即停止
        self._token_usage: dict[str, dict[str, Any]] = {}            # 各 Agent 用量 {agent: {input, output, cost_usd}}
        self._research_round = 0
        self._research_exhausted = False  # 补充研究零增益后置 True
        self._language = "zh"             # 报告语言，_pipeline 开始时按任务参数设置
        self._started_at: float = time.time()  # run/replay 开始时由 _prepare 重置
        self.interrupted = False          # 因停止/暂停超时而中断（run/replay 此时返回提示文本而非报告）
        self.loop_ask = LoopAsk(self._emit, lambda: (self._pause_event, self._stop_event))  # 改进循环中的询问

        print("\n🔧 正在初始化智能体...", flush=True)
        role = self.profile.model_for
        self.planner = PlannerAgent(model=role("planner"))
        self.researcher = ResearcherAgent(model=role("researcher"))
        self.analyst = AnalystAgent(model=role("analyst"))
        self.writer = WriterAgent(model=role("writer"))
        self.critic = CriticAgent(model=role("critic"))
        self.source_verifier = SourceVerifierAgent(model=role("source_verifier"))
        self.fact_checker = FactCheckerAgent(model=role("fact_checker"))
        self.conclusion_validator = ConclusionValidatorAgent(model=role("conclusion_validator"))
        self.reconciler = ReconcilerAgent(model=role("reconciler"))
        self._agents = [self.planner, self.researcher, self.analyst, self.writer, self.critic,
                        self.source_verifier, self.fact_checker, self.conclusion_validator,
                        self.reconciler]
        for agent in self._agents:
            agent.stream_callback = self._emit
        print("✅ 所有智能体已就绪（含验证智能体）", flush=True)

    # ── 基础设施 ────────────────────────────────────────────────────────────

    @property
    def _ws(self) -> str:
        """阶段方法使用的工作空间路径（run/replay 先于各阶段设置）"""
        if self.workspace is None:
            raise RuntimeError("工作空间尚未创建")
        return self.workspace

    def _emit(self, event_type: str, data: dict):
        """统计用量并转发进度事件（API 模式）"""
        if event_type == "token_usage":
            u = self._token_usage.setdefault(data.get("agent", "unknown"),
                                             {"input": 0, "cached_input": 0, "output": 0, "cost_usd": 0.0})
            u["input"] += data.get("total_input", 0)
            u["cached_input"] = u.get("cached_input", 0) + data.get("cached_input", 0)  # 旧检查点没有该字段
            u["output"] += data.get("total_output", 0)
            u["cost_usd"] += data.get("cost_usd", 0.0)
        if self.progress_callback:
            self.progress_callback(event_type, data)

    def _checkpoint(self, phase_name: str) -> str | None:
        """
        阶段间检查点：停止返回 None；暂停时阻塞等待恢复（最多 30 分钟）；
        有待处理的用户消息时返回合并后的附加指令，否则返回空串。
        """
        if self._stop_event and self._stop_event.is_set():
            print(f"\n🛑 收到停止信号（阶段：{phase_name}），立即终止", flush=True)
            return None

        if self._pause_event is not None and not self._pause_event.is_set():
            self._emit("paused", {"phase": phase_name})
            print(f"\n⏸️  任务已暂停（阶段：{phase_name}），等待恢复...", flush=True)
            self._pause_event.wait(timeout=1800)
            if not self._pause_event.is_set():
                return None
            self._emit("resumed", {"phase": phase_name})
            print(f"\n▶️  任务已恢复（阶段：{phase_name}）", flush=True)

        if not self._user_messages:
            return ""
        msgs = self._user_messages[:]
        self._user_messages.clear()
        combined = "\n\n".join(f"【用户补充指令 {i+1}】{m}" for i, m in enumerate(msgs))
        self._emit("user_message_ack", {"messages": msgs, "phase": phase_name})
        print(f"\n💬 接收到用户指令（阶段 {phase_name}）：{combined[:100]}", flush=True)
        self._log(f"用户指令注入 at {phase_name}: {combined[:200]}")
        return combined

    def _gate(self, phase_name: str) -> str:
        extra = self._checkpoint(phase_name)
        if extra is None:
            raise _Interrupted(phase_name)
        return extra

    def _create_workspace(self, question: str, extra: dict | None = None) -> str:
        """创建本次研究的工作空间"""
        self.session_id = datetime.now().strftime("%Y%m%d_%H%M%S")
        workspace = os.path.join(WORKSPACE_DIR, f"session_{self.session_id}")
        for subdir in ["04_research", "04_clarification", "06_drafts", "07_reviews",
                       "08_verification", "08_messages"]:
            os.makedirs(os.path.join(workspace, subdir), exist_ok=True)

        write_json(os.path.join(workspace, "00_session.json"), {
            "session_id": self.session_id,
            "created_at": datetime.now().isoformat(),
            "question": question,
            "status": "initialized",
            "model": self.profile.core,
            "provider": self.profile.provider,
            **(extra or {}),
        })
        write_file(os.path.join(workspace, "01_question.txt"), question)

        self.log_file = os.path.join(workspace, "research_log.txt")
        append_to_log(self.log_file, f"研究会话启动: {question}")
        print(f"\n📁 工作空间: {workspace}", flush=True)
        self._emit("session", {"session_id": self.session_id, "workspace": workspace})
        return workspace

    def _attach_workspace(self, workspace: str):
        """重放：接管已有会话的工作空间。"""
        self.workspace = workspace
        self.session_id = os.path.basename(os.path.normpath(workspace)).removeprefix("session_")
        self.log_file = os.path.join(workspace, "research_log.txt")
        self._emit("session", {"session_id": self.session_id, "workspace": workspace})

    def _log(self, message: str):
        if self.log_file:
            append_to_log(self.log_file, message)

    def _update_status(self, status: str, extra: dict | None = None):
        if not self.workspace or is_workspace_deleted(self.workspace):  # 会话已被删除：不再写状态，也不再广播
            return
        meta_file = os.path.join(self.workspace, "00_session.json")
        meta = read_json(meta_file) if os.path.exists(meta_file) else {}
        meta["status"] = status
        meta["last_updated"] = datetime.now().isoformat()
        if extra:
            meta.update(extra)
        write_json(meta_file, meta)
        self._emit("status", {"status": status, **(extra or {})})

    def _phase(self, num, title: str, status: str, name: str):
        print(f"\n{'='*70}\n{title}\n{'='*70}", flush=True)
        self._update_status(status)
        self._emit("phase", {"phase": num, "name": name})

    def _soft(self, what: str, fn, *args, **kwargs):
        """执行非关键步骤：调用失败只告警并返回 None；停止请求照常向上抛。"""
        try:
            return fn(*args, **kwargs)
        except ResearchStopped:
            raise
        except LLMError as e:
            print(f"  [警告] {what}失败: {e}", flush=True)
            self._log(f"{what}失败: {e}")
            return None

    # ── 入口 ────────────────────────────────────────────────────────────────

    def run(self, question: str, research_strategy: str | None = None,
            intent_meta: dict | None = None,
            pause_event=None, stop_event=None,
            min_cycles: int | None = None,
            max_cycles: int | None = None,
            depth: str | None = None,
            language: str = "zh",
            max_queries: int | None = None,
            ask_loop: bool = False):
        """执行完整的研究流程，返回最终报告正文（中断时返回提示文本）。

        depth：研究深度档（config.DEPTH_PRESETS），默认 config.DEFAULT_DEPTH。
        min_cycles / max_cycles：本次任务级别的轮数覆盖，优先于档位的轮数范围。
        language：最终报告的撰写语言（zh/en），写入检查点参数，重放沿用。
        max_queries：覆盖档位的规划查询数。ask_loop：改进循环中即时询问用户是否继续（需有界面应答，默认关）。
        """
        self._prepare(pause_event, stop_event)
        print(f"\n{'='*70}\n🚀 多智能体研究系统启动（含质量验证流程）\n{'='*70}", flush=True)
        depth = depth or _config.DEFAULT_DEPTH
        policy = self._loop_policy(intent_meta, depth, min_cycles, max_cycles)
        params = {"question": question, "strategy": self._strategy(intent_meta, research_strategy),
                  "policy": asdict(policy), "depth": depth, "language": language,
                  "max_queries": max_queries, "ask_loop": ask_loop}
        self.workspace = self._create_workspace(question, {
            "language": language,
            "resolved_params": resolve_params(depth, language, min_cycles, max_cycles, max_queries,
                                              self.profile, ask_loop)})
        return self._guarded({"params": params}, 0)

    def replay(self, workspace: str, from_phase: str | None = None, pause_event=None, stop_event=None):
        """在已有会话上重放：workspace 回滚到 from_phase 前一阶段的检查点后继续跑完。
        from_phase 为 None 时从断点续跑（第一个没有检查点的阶段）。沿用检查点里的问题、策略与轮数策略。"""
        self._prepare(pause_event, stop_event)
        start, ctx, old_hash = Checkpoints(workspace).rollback(from_phase)
        self._attach_workspace(workspace)
        runtime = ctx.pop("runtime")
        self._research_round, self._research_exhausted = runtime["research_round"], runtime["research_exhausted"]
        self._token_usage = runtime["token_usage"]
        print(f"\n{'='*70}\n🔁 重放研究会话 {self.session_id}：从阶段 {PHASES[start]} 开始\n{'='*70}", flush=True)
        self._log(f"重放：从阶段 {PHASES[start]} 开始")
        if old_hash != self._params_hash(ctx["params"]):
            print("  [提示] 模型配置与检查点生成时不同，后续阶段将使用当前配置", flush=True)
            self._log("重放时模型配置已变更")
        return self._guarded(ctx, start)

    def _prepare(self, pause_event, stop_event):
        self._pause_event = pause_event
        self._stop_event = stop_event
        for agent in self._agents:
            agent.stop_event = stop_event
        self._started_at = time.time()

    def _guarded(self, ctx: dict, start: int) -> str:
        try:
            return self._pipeline(ctx, start)
        except (_Interrupted, ResearchStopped, WorkspaceDeleted) as e:  # 会话被删除时写盘处抛 WorkspaceDeleted
            print(f"\n🛑 任务已中断：{e}", flush=True)
            self.interrupted = True
            self._update_status("stopped")
            return "任务已中断"

    def _loop_policy(self, intent_meta, depth, min_cycles, max_cycles) -> LoopPolicy:
        preset = _config.DEPTH_PRESETS[depth]
        min_eff, max_eff = resolve_cycles(preset, min_cycles, max_cycles)
        intent = (intent_meta or {}).get("intent_type", "info_seeking")
        print(f"🎯 意图类型: {intent} | 研究深度: {depth} | 改进轮数: {min_eff}-{max_eff}", flush=True)
        return LoopPolicy(min_cycles=min_eff, max_cycles=max_eff,
                          quality_threshold=_config.QUALITY_THRESHOLD,
                          conclusion_threshold=_config.CONCLUSION_THRESHOLD,
                          no_gain_patience=_config.NO_GAIN_PATIENCE)

    def _strategy(self, intent_meta, research_strategy) -> str | None:
        hint = INTENT_STRATEGY_HINT.get((intent_meta or {}).get("intent_type", "info_seeking"), "")
        if not hint:
            return research_strategy
        line = f"研究策略偏向：{hint}"
        return f"{research_strategy}\n{line}" if research_strategy else line

    def _pipeline(self, ctx: dict, start: int) -> str:
        """按 PHASES 顺序执行各阶段；每个阶段完成后写检查点（ctx 为阶段间传递的可 JSON 化上下文）。"""
        checkpoints = Checkpoints(self._ws)
        digest = self._params_hash(ctx["params"])
        self._language = ctx["params"].get("language", "zh")  # V4 之前的检查点没有该字段
        for phase in PHASES[start:]:
            getattr(self, f"_step_{phase}")(ctx)
            runtime = {"research_round": self._research_round, "research_exhausted": self._research_exhausted,
                       "token_usage": self._token_usage}
            checkpoints.save(phase, {**{k: v for k, v in ctx.items() if k != "result"}, "runtime": runtime}, digest)
            self._emit("checkpoint", {"phase": phase, "params_hash": digest})
        return ctx["result"]

    def _params_hash(self, params: dict) -> str:
        return params_hash(params, {"core": self.profile.core, "support": self.profile.support})

    @staticmethod
    def _preset(ctx) -> dict:
        # E5 之前的检查点没有 depth，当时的行为等同 deep 档
        return _config.DEPTH_PRESETS[ctx["params"].get("depth", "deep")]

    def _step_clarify(self, ctx):
        ctx["q"] = self._phase_clarify(ctx["params"]["question"])

    def _step_plan(self, ctx):
        n_queries = ctx["params"].get("max_queries") or self._preset(ctx)["queries"]  # V5 之前的检查点没有该字段
        ctx["plan"] = self._phase_plan(ctx["q"], ctx["params"]["strategy"], n_queries)

    def _step_research(self, ctx):
        self._phase_research(ctx["plan"], ctx["q"])

    def _step_sources(self, ctx):
        ctx["sv"] = self._phase_verify_sources(ctx["plan"], ctx["q"], self._preset(ctx)["source_supplement"])

    def _step_ledger(self, ctx):
        ctx["fc"] = self._phase_ledger(self._preset(ctx)["verify"])

    def _step_analyze(self, ctx):
        self._phase_analyze(ctx["q"])

    def _step_draft(self, ctx):
        self._phase_first_draft(ctx["q"], key_entities_of(ctx["plan"]))

    def _step_improve(self, ctx):
        policy = LoopPolicy(**ctx["params"]["policy"])
        preset = self._preset(ctx)
        self.loop_ask.enabled = ctx["params"].get("ask_loop", False)  # 旧检查点没有该字段，按关闭处理
        state, validations = self._phase_improve(ctx["q"], ctx["plan"], ctx["sv"], ctx["fc"], policy,
                                                 preset["supplements"], preset["recheck"])
        ctx["loop"] = asdict(state)
        ctx["validations"] = {str(d): cv for d, cv in validations.items()}  # JSON 键只能是字符串

    def _step_finish(self, ctx):
        loop = ctx["loop"]
        state = LoopState(**{**loop, "reviewed": {int(d): s for d, s in loop["reviewed"].items()}})
        final = self._select_final(state)
        report_file = self._phase_confidence(ctx["sv"], ctx["fc"], ctx["validations"].get(str(final["draft"])))
        params = ctx["params"]
        ctx["result"] = self._phase_finish(params["question"], params["strategy"], state,
                                           ctx["sv"], ctx["fc"], report_file, final)

    # ── 阶段 1-5 ────────────────────────────────────────────────────────────

    def _phase_clarify(self, question: str) -> str:
        """澄清由调用方（API 的 ClarifierAgent / main.py 交互模式）在 run 之前完成，这里只落盘。"""
        self._phase(1, "📝 阶段 1/8：意图识别与澄清", "clarifying", "问题澄清")
        write_json(os.path.join(self._ws, "04_clarification", "clarification.json"),
                   {"original_question": question, "analysis": "", "final_question": question})
        self._log(f"研究方向确认: {question[:200]}")
        extra = self._gate("阶段1→2")
        return f"{question}\n\n{extra}" if extra else question

    def _phase_plan(self, q: str, strategy: str | None, n_queries: int) -> dict:
        self._phase(2, "📋 阶段 2/8：研究规划", "planning", "研究规划")
        plan = self.planner.create_plan(self._ws, q, research_strategy=strategy, n_queries=n_queries)
        n_queries = len(plan["search_queries"])
        print(f"\n✅ 研究计划完成：{len(plan['key_aspects'])} 个研究维度，{n_queries} 个搜索查询", flush=True)
        self._log(f"研究计划创建完成，{n_queries} 个搜索查询")
        self._emit("plan", {**{k: plan.get(k) for k in ("objective", "domain", "key_aspects",
                                                         "search_queries", "expected_output",
                                                         "depth_requirement")},
                            "total_queries": n_queries})
        extra = self._gate("阶段2→3")
        if extra:
            plan.setdefault("user_directives", []).append(extra)
        return plan

    def _next_round(self) -> int:
        self._research_round += 1
        return self._research_round

    def _research_bytes(self) -> int:
        d = os.path.join(self._ws, "04_research")
        return sum(os.path.getsize(os.path.join(d, f)) for f in os.listdir(d)
                   if os.path.isfile(os.path.join(d, f))) if os.path.isdir(d) else 0

    def _supplement(self, plan: dict, queries: list, label: str):
        """补充研究：失败只告警。某轮没有带来任何新声明后，不再做补充研究（零增益研究停止）。"""
        if self._research_exhausted:
            print(f"  [研究员] 上一轮补充研究未产生新声明，跳过{label}补充研究", flush=True)
            return None
        round_num = self._next_round()
        done = self._soft(f"{label}补充研究", self.researcher.research, self._ws, plan,
                          round_num=round_num, additional_queries=queries)
        ran = done is not None and os.path.exists(done)  # 查询全部执行过时研究员会跳过、不写文件
        if ran and Ledger.load(self._ws).new_claims_in_round(round_num) == 0:
            self._research_exhausted = True
            self._log(f"第 {round_num} 轮补充研究未产生新声明，停止后续补充研究")
        return round_num if ran else None

    def _phase_research(self, plan: dict, q: str):
        self._phase(3, "🔍 阶段 3/8：网络研究", "researching", "网络研究")
        self.researcher.research(self._ws, plan, round_num=self._next_round())
        print("\n✅ 第1轮研究完成", flush=True)
        self._log("第1轮研究完成")

        for retry in range(2):
            size = self._research_bytes()
            if size >= MIN_RESEARCH_BYTES:
                return
            print(f"\n⚠️  研究内容不足（{size} 字节），重试 {retry + 1}/2...", flush=True)
            self._supplement(plan, [q], "快速失败重试")
        if self._research_bytes() < MIN_RESEARCH_BYTES:
            print("  [警告] 重试后研究内容仍不足，继续后续流程", flush=True)

    def _phase_verify_sources(self, plan: dict, q: str, supplement: bool) -> dict:
        self._phase(3.5, "🔎 阶段 3.5/8：来源可信度验证", "verifying_sources", "来源验证")
        sv, _ = self.source_verifier.verify_sources(self._ws)
        s = sv["summary"]
        print(f"\n✅ 来源验证完成：{sv['total_sources']} 个来源\n"
              f"   高可信: {s['high_confidence_count']}  中等: {s['medium_confidence_count']}  "
              f"低可信: {s['low_confidence_count']}\n"
              f"   整体质量: {s['overall_quality']}  平均分: {s['average_score']:.1f}/100", flush=True)
        self._log(f"来源验证完成，整体质量: {s['overall_quality']}")
        if supplement and s["overall_quality"] in ("poor", "fair"):
            print("\n⚠️  来源质量不佳，触发补充研究...", flush=True)
            self._supplement(plan, [f"权威来源 {q[:40]}"], "来源质量")
        self._gate("阶段3→4")
        return sv

    def _phase_analyze(self, q: str):
        self._phase(4, "🧐 阶段 4/8：分析综合", "analyzing", "分析综合")
        self.analyst.analyze(self._ws, q)
        print("\n✅ 分析完成", flush=True)
        self._log("分析综合完成")
        self._gate("阶段4→5")

    def _phase_first_draft(self, q: str, key_entities: list):
        self._phase(5, "✍️  阶段 5/8：初稿写作", "writing", "初稿写作")
        self.writer.write_draft(self._ws, q, draft_num=0, language=self._language, key_entities=key_entities)
        print("\n✅ 初稿完成", flush=True)
        self._log("初稿写作完成")

    # ── 阶段 6：改进循环 ────────────────────────────────────────────────────

    def _phase_ledger(self, verify_limit: int) -> dict | None:
        """声明台账：全量对账（去重、找矛盾）→ 裁决矛盾 + 独立核实关键声明。均为非关键步骤。"""
        self._phase(3.8, "📒 阶段 3.8/8：声明台账（对账 + 事实核查）", "fact_checking", "事实核查")
        self._soft("声明对账", self.reconciler.reconcile, self._ws, since_round=0)
        result = self._soft("事实核查", self.fact_checker.check_facts, self._ws, limit=verify_limit)
        ledger = Ledger.load(self._ws)
        print(f"✅ 台账：{len(ledger.citable())} 条可引用声明，{len(ledger.sources)} 个来源，"
              f"{len(ledger.contradictions)} 处矛盾（未决 {len(ledger.unresolved())}）", flush=True)
        if result is None:
            return None
        fc = result[0]
        print(f"✅ 事实核查：独立核实 {fc['total_claims_checked']} 条，置信度 {fc['overall_confidence']:.0%}",
              flush=True)
        self._log(f"事实核查完成：{fc['fact_check_summary']}")
        return fc

    def _supplement_and_reconcile(self, plan: dict, queries: list, cycle: int):
        """循环内补充研究：新声明对账后立即裁决新出现的矛盾（保证停止前矛盾已处理）。"""
        round_num = self._supplement(plan, queries, f"第 {cycle} 轮")
        if round_num is None:
            return
        self._soft("声明对账", self.reconciler.reconcile, self._ws, since_round=round_num)
        self._soft("矛盾裁决", self.fact_checker.adjudicate, self._ws)

    def _phase_improve(self, q: str, plan: dict, sv: dict, fc: dict | None, policy: LoopPolicy,
                       max_supplements: int, recheck_budget: int):
        self._phase(6, f"🔄 阶段 6/8：质量评审与改进循环（{policy.min_cycles}-{policy.max_cycles} 轮）",
                    "improving", "评审优化")
        state, validations, current, supplements = LoopState(), {}, 0, 0
        entities = key_entities_of(plan)
        self._citations = {}
        for cycle in range(1, policy.max_cycles + 1):
            self._gate(f"改进循环第{cycle}轮")
            print(f"\n{'─'*70}\n🔄 第 {cycle}/{policy.max_cycles} 轮：评审第 {current} 版\n{'─'*70}", flush=True)
            self._emit("cycle_start", {"cycle": cycle, "max": policy.max_cycles})
            self.loop_ask.round_start(cycle, state, self._token_usage)
            self._citations[current] = self._annotate(current)
            reviewed = self._soft("评审", self.critic.review, self._ws, current, cycle,
                                 key_entities=entities)
            if reviewed is None:
                print(f"  [错误] 评审失败，结束改进循环，保留最优第 {state.best_draft} 版", flush=True)
                self._emit("loop_stop", {"cycle": cycle, "reason": "评审失败"})
                break
            review, review_file = reviewed
            score = self._record_review(state, current, review, review_file, cycle, policy)
            validations[current] = self._validate(current, sv, fc, cycle)
            cv = validations[current]
            reason = stop_reason(policy, state, score, cv["average_score"] if cv else None,
                                 blockers=self._blockers(current))
            if not reason:  # 本轮不停止：评审分在达标线附近徘徊时问用户是否还要再改一轮
                reason = self.loop_ask.consult(policy, state, cycle, score, self._citations, self._token_usage)
            if reason:
                print(f"\n🏁 结束改进循环：{reason}", flush=True)
                self._log(f"结束改进循环：{reason}")
                self._emit("loop_stop", {"cycle": cycle, "reason": reason})
                break
            if recheck_budget > 0:
                recheck_budget -= self._recheck_load_bearing(state, recheck_budget)
            if supplements < max_supplements and review["additional_research_needed"]:
                supplements += 1
                self._supplement_and_reconcile(plan, _to_queries(review["additional_research_needed"]), cycle)
            next_draft = self._rewrite(q, state, entities)
            if next_draft is None:
                self._emit("loop_stop", {"cycle": cycle, "reason": "改进写作失败"})
                break
            current = next_draft
        return state, validations

    def _recheck_load_bearing(self, state: LoopState, limit: int) -> int:
        """承重声明补核：最优稿中被引用最多、仍未核查且本应有一手记录的声明，按剩余预算独立核实并写回台账。
        放在「决定继续」之后、改写之前——只有紧接着还有一次改写时，核实结果（经声明表的状态）才能进入报告；
        返回消耗的预算（发起核实的条数，失败的也计入以封顶成本）。"""
        text = read_text(self._draft_path(state.best_draft))
        done = self._soft("承重声明补核", self.fact_checker.recheck, self._ws, text, limit) or []
        if done:
            print(f"   🔎 承重声明补核：独立核实第 {state.best_draft} 版中的 {len(done)} 条声明（{', '.join(done)}）",
                  flush=True)
            self._log(f"承重声明补核：{', '.join(done)}")
        return len(done)

    def _draft_path(self, draft: int) -> str:
        return os.path.join(self._ws, "06_drafts", f"draft_{draft}.md")

    def _annotate(self, draft: int, verbose: bool = True) -> dict:
        """按当前台账重新生成草稿的「声明来源」附录并检查引用；返回检查结果。"""
        path = self._draft_path(draft)
        text, check = with_references(Ledger.load(self._ws), read_text(path), self._language)
        write_file(path, text)
        if verbose:
            cov = check["numeric_coverage"]
            print(f"   📎 第 {draft} 版引用：{len(check['cited'])} 条声明，数字句覆盖率 "
                  f"{'N/A' if cov is None else f'{cov:.0%}'}，违规 {len(check['violations'])} 处", flush=True)
        return check

    def _blockers(self, draft: int) -> int:
        """阻塞「质量达标」的问题数：本版引用违规 + 台账中未裁决的矛盾。"""
        n = len(self._citations[draft]["violations"]) + len(Ledger.load(self._ws).unresolved())
        if n:
            print(f"   ⛔ 阻塞项 {n} 个（引用违规或矛盾未裁决），本轮不能以质量达标结束", flush=True)
        return n

    def _select_final(self, state: LoopState) -> dict:
        """用最终台账复查每一版评审过的草稿，按 pick_final 选：无违规者取最高分；全有违规时在分数相近者中取违规最少。"""
        if not state.reviewed:
            self._emit("final_selected", {"draft": 0, "best_scored_draft": None, "reason": "没有评审过的草稿"})
            return {"draft": 0, "check": self._annotate(0, verbose=False)}
        checks = {d: self._annotate(d, verbose=False) for d in state.reviewed}
        violations = {d: len(c["violations"]) for d, c in checks.items()}
        final = pick_final(state.reviewed, violations)
        if final != state.best_draft:
            print(f"\n📌 最终稿选第 {final} 版：最优分的第 {state.best_draft} 版存在引用违规", flush=True)
        self._emit("final_selected", {"draft": final, "best_scored_draft": state.best_draft,
                                      "scores": {str(d): s for d, s in state.reviewed.items()},
                                      "violations": {str(d): n for d, n in violations.items()}})
        return {"draft": final, "check": checks[final]}

    def _record_review(self, state: LoopState, draft: int, review: dict, review_file: str,
                       cycle: int, policy: LoopPolicy) -> float:
        score = review["average_score"]
        self._display_review_summary(review, cycle)
        self._log(f"第 {cycle} 轮评审完成（第 {draft} 版），平均分: {score:.1f}")
        if state.record(draft, score, review_file, policy.min_gain):
            print(f"   ⭐ 新最优草稿: 第 {draft} 版（分数 {score:.1f}）", flush=True)
        else:
            print(f"   ↩️  未超过最优（{score:.2f}，最优 {state.best_score:.2f}），"
                  f"下一版基于第 {state.best_draft} 版改进", flush=True)
        return score

    def _validate(self, draft: int, sv: dict, fc: dict | None, cycle: int) -> dict | None:
        print(f"\n🔬 结论验证（第 {draft} 版）", flush=True)
        draft_file = os.path.join(self._ws, "06_drafts", f"draft_{draft}.md")
        result = self._soft("结论验证", self.conclusion_validator.validate_conclusions,
                            self._ws, draft_file=draft_file,
                            source_verification=sv, fact_check=fc, cycle=cycle)
        if result is None:
            return None
        cv = result[0]
        print(f"   验证结果: {cv['overall_verdict']}  平均分: {cv['average_score']:.1f}  "
              f"综合置信度: {_pct(cv['conclusion_confidence'])}", flush=True)
        self._log(f"结论验证完成: {cv['overall_verdict']}，平均分 {cv['average_score']:.1f}")
        return cv

    def _rewrite(self, q: str, state: LoopState, key_entities: list) -> int | None:
        """基于最优稿与其评审意见写新一版（编号单调递增）；失败返回 None。"""
        new = state.next_draft()
        print(f"\n✍️  改进报告：基于第 {state.best_draft} 版生成第 {new} 版", flush=True)
        issues = format_violations(self._citations.get(state.best_draft, {}).get("violations", []))
        out = self._soft("改进写作", self.writer.write_draft, self._ws, q, draft_num=new,
                         review_file=state.best_review_file, base_draft=state.best_draft,
                         citation_issues=issues, language=self._language, key_entities=key_entities)
        if out is None:
            print(f"  [错误] 改进写作失败，结束改进循环，保留最优第 {state.best_draft} 版", flush=True)
            return None
        print(f"✅ 第 {new} 版草稿完成（{os.path.getsize(out):,} 字节）", flush=True)
        self._log(f"第 {new} 版草稿完成")
        return new

    def _display_review_summary(self, review: dict, cycle: int):
        scores, avg = review["scores"], review["average_score"]
        print(f"\n📊 第 {cycle} 轮评审结果：\n   平均分：{avg:.1f}/10", flush=True)
        for dim, name in DIM_NAMES.items():
            v = scores.get(dim, 0)
            print(f"   {name:8s}: {'█' * int(v)}{'░' * (10 - int(v))} {v:.0f}/10", flush=True)
        issues = review["critical_issues"]
        high = sum(1 for i in issues if i["severity"] == "high")
        print(f"   关键问题：{len(issues)} 个（高优先级：{high} 个）", flush=True)
        print(f"   总体评价：{review['overall_assessment'][:100]}", flush=True)
        self._emit("review", {"cycle": cycle, "avg_score": avg, "scores": scores})

    # ── 阶段 7-8 ────────────────────────────────────────────────────────────

    def _phase_confidence(self, sv: dict, fc: dict | None, cv: dict | None) -> str:
        """综合置信度报告（针对最终采用的最优稿）；缺失部分剔除后归一化。"""
        self._phase(7, "📊 阶段 7/8：生成置信度报告", "confidence_report", "置信度报告")
        report = build_confidence_report(sv, fc, cv)
        report_file = os.path.join(self._ws, "08_verification", "confidence_report.json")
        write_json(report_file, report)
        self._emit("confidence_report", report)
        print(f"✅ 置信度报告生成完成（综合 {_pct(report['overall_confidence'])}"
              f"{'，缺失: ' + ', '.join(report['missing']) if report['missing'] else ''}）", flush=True)
        self._log("置信度报告生成完成")
        return report_file

    def _phase_finish(self, question, strategy, state: LoopState, sv, fc, report_file, final: dict) -> str:
        elapsed = time.time() - self._started_at
        cost = sum(u["cost_usd"] for u in self._token_usage.values())
        final_file = os.path.join(self._ws, "09_final.md")
        draft, check = final["draft"], final["check"]
        score = state.reviewed.get(draft, 0.0)
        write_file(final_file, read_text(self._draft_path(draft)) + _violations_appendix(check, self._language)
                   + self._quality_appendix(read_json(report_file), state, draft, score))

        citations = {"cited_claims": len(check["cited"]), "violations": len(check["violations"]),
                     "numeric_coverage": check["numeric_coverage"]}
        self._emit("stats", {
            "cycles": state.completed,
            "claims_checked": fc["total_claims_checked"] if fc else 0,
            "total_sources": sv["total_sources"],
            "final_score": round(score, 1),
            "elapsed_seconds": round(elapsed),
            "cost_usd": round(cost, 3),
            **citations,
        })
        self._update_status("completed", {
            "total_cycles": state.completed, "final_score": score,
            "final_draft": draft, "best_scored_draft": state.best_draft, "score_history": state.scores,
            "final_report": final_file, "elapsed_seconds": round(elapsed), "citations": citations,
            "token_usage": self._usage_summary(),
        })
        self._log(f"研究完成，共 {state.completed} 轮评审，最终采用第 {draft} 版（{score:.1f}）")
        self._append_history(question, strategy, state)
        print(f"\n{'='*70}\n🎊 研究完成！\n{'='*70}\n"
              f"📊 质量分数历程: {' → '.join(f'{s:.1f}' for s in state.scores)}\n"
              f"🏆 最终采用: 第 {draft} 版（{score:.1f}）| 引用 {citations['cited_claims']} 条声明，"
              f"违规 {citations['violations']} 处\n"
              f"⏱️  总耗时: {elapsed / 60:.1f} 分钟 | 💰 等价费用: ${cost:.2f}\n"
              f"📁 工作空间: {self._ws}\n📄 最终报告: {final_file}\n"
              f"📋 置信度报告: {report_file}", flush=True)
        return read_text(final_file)

    def _quality_appendix(self, conf: dict, state: LoopState, draft: int, score: float) -> str:
        bd = conf["breakdown"]
        t = QUALITY_TEXT.get(self._language, QUALITY_TEXT["zh"])
        na = t["na"]
        return f"""

---
## {heading_for(QUALITY_HEADINGS, self._language)}

| {t['dimension']} | {t['score']} |
|------|------|
| {t['overall']} | {_pct(conf['overall_confidence'], na)} |
| {t['source']} | {bd['source_quality']['quality_rating'] or na} |
| {t['fact']} | {_pct(bd['fact_accuracy']['score'], na)} |
| {t['conclusion']} | {_pct(bd['conclusion_validity']['score'], na)} |
| {t['rounds']} | {t['rounds_value'].format(n=state.completed)} |
| {t['final']} | {t['final_value'].format(score=score, draft=draft)} |

*{t['footer']}*
"""

    def _usage_summary(self) -> dict:
        total_in = sum(u["input"] for u in self._token_usage.values())
        total_out = sum(u["output"] for u in self._token_usage.values())
        cached = sum(u.get("cached_input", 0) for u in self._token_usage.values())
        return {"total_input": total_in, "total_cached_input": cached, "total_output": total_out,
                "total": total_in + total_out,
                "cost_usd": round(sum(u["cost_usd"] for u in self._token_usage.values()), 3),
                "by_agent": self._token_usage}

    def _append_history(self, question, strategy, state: LoopState):
        entry = {"session_id": self.session_id, "timestamp": datetime.now().isoformat(),
                 "question": question, "research_strategy": strategy,
                 "final_score": state.best_score, "total_cycles": state.completed,
                 "score_history": state.scores, "best_score": state.best_score,
                 "workspace": self.workspace}
        try:
            with open(os.path.join(WORKSPACE_DIR, "research_history.jsonl"), "a", encoding="utf-8") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        except OSError as e:
            print(f"  [警告] 历史记录写入失败: {e}", flush=True)


def _to_queries(requests: list) -> list:
    """评审的补充研究需求 → 研究员查询（保留所针对的声明编号与缺口说明，便于追溯）。"""
    return [{"query": r["topic"], "priority": "high", "category": "补充",
             "purpose": f"{r['reason']}（针对 {r['claim_id']}）" if r["claim_id"] else r["reason"]}
            for r in requests]


def _violations_appendix(check: dict, language: str = "zh") -> str:
    """最终稿仍有引用违规时如实列出（所有评审过的版本都有违规时才会出现）。"""
    if not check["violations"]:
        return ""
    return (f"\n\n## {heading_for(VIOLATIONS_HEADINGS, language)}\n"
            f"{format_violations(check['violations'], language)}\n")


def build_confidence_report(sv: dict | None, fc: dict | None, cv: dict | None) -> dict:
    """置信度报告（字段与前端 ConfidenceReport 兼容；缺失部分 score 为 None、weight 标"未完成"）。"""
    scores = component_scores(sv, fc, cv)
    combined = combine(scores)
    w = combined["weights_used"]

    def weight(k):
        return f"{w[k]:.0%}" if k in w else "未完成"

    sv_summary = (sv or {}).get("summary", {})
    return {
        "generated_at": datetime.now().isoformat(),
        "overall_confidence": combined["overall"],
        "confidence_level": level(combined["overall"]),
        "missing": combined["missing"],
        "breakdown": {
            "source_quality": {"weight": weight("source_quality"), "score": scores["source_quality"],
                               "average_domain_score": sv_summary.get("average_score"),
                               "quality_rating": sv_summary.get("overall_quality"),
                               "high_confidence_sources": sv_summary.get("high_confidence_count", 0)},
            "fact_accuracy": {"weight": weight("fact_accuracy"), "score": scores["fact_accuracy"],
                              "claims_checked": fc["total_claims_checked"] if fc else 0,
                              "disputed_claims_count": len(fc["disputed_claims"]) if fc else 0,
                              "degraded": bool(fc and fc.get("degraded"))},
            "conclusion_validity": {"weight": weight("conclusion_validity"),
                                    "score": scores["conclusion_validity"],
                                    "average_validation_score": cv["average_score"] if cv else None,
                                    "overall_verdict": cv["overall_verdict"] if cv else None},
        },
        "top_sources": (sv or {}).get("top_sources", []),
        "disputed_claims": fc["disputed_claims"][:5] if fc else [],
        "gaps": cv["gaps"] if cv else [],
        "recommended_improvements": cv["improvement_instructions"] if cv else "",
    }
