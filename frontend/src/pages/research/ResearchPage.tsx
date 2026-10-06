import { useState, useEffect, useRef, useCallback } from "react";
import { Plus, Copy, Check, ChevronDown, ChevronUp, Pause, Play, Download, Square } from "lucide-react";
import { setWorkInProgress } from "../../lib/workGuard";
import { toast } from "sonner";
import { ReportBody, LedgerPanels } from "./ReportView";
import { SessionHistoryPanel } from "./SessionHistoryPanel";
import { SessionList, sessionKey } from "./SessionList";
import { ModelPicker, DEFAULT_CHOICE, modelRequest } from "./ModelPicker";
import type { ModelChoice } from "./ModelPicker";
import { UsagePanel, addUsage } from "./UsagePanel";
import { LoopDecisionCard, toDecision, withTimer } from "./LoopDecisionCard";
import type { LoopDecision } from "./LoopDecisionCard";
import { useTaskStream, loadActiveTask, saveActiveTask, clearActiveTask } from "./useTaskStream";
import type { StreamEvent } from "./useTaskStream";
import { research, withToken } from "../../lib/api";
import type { SessionMeta, PipelineStep, LogLine, ConfidenceReport, TokenUsage } from "../../lib/types";
import { STATUS_TO_STEP, initSteps, advanceSteps, StepPipeline, LogArea, StreamArea, ConfidenceGauge } from "./widgets";
import type { DraftFile, Depth } from "../../lib/api";
import { useT, locale, type Lang, type TKey } from "../../i18n";
import { useSettings } from "../../lib/useSettings";

// ── Main Page ──────────────────────────────────────────────────────────────

export default function ResearchPage() {
  const { t, lang } = useT();
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [sessionTotal, setSessionTotal] = useState(0);
  const [question, setQuestion] = useState("");
  const [clarification, setClarification] = useState("");
  const [showClarify, setShowClarify] = useState(false);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "running" | "paused" | "completed" | "error">("idle");
  const [steps, setSteps] = useState<PipelineStep[]>(initSteps());
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [streamText, setStreamText] = useState("");
  const [streamAgent, setStreamAgent] = useState("");
  const [streamDone, setStreamDone] = useState(false);
  const [report, setReport] = useState<string | null>(null);
  const [confidence, setConfidence] = useState<ConfidenceReport | null>(null);
  const [usage, setUsage] = useState<TokenUsage | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [injectMsg, setInjectMsg] = useState("");
  const [copied, setCopied] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [showReport, setShowReport] = useState(true);
  const [depth, setDepth] = useState<Depth | "custom">(() => {
    const saved = localStorage.getItem("cr.depth");
    return saved === "quick" || saved === "deep" || saved === "custom" ? saved : "standard";
  });
  const [maxCycles, setMaxCycles] = useState<number>(() => {
    const saved = Number(localStorage.getItem("cr.maxCycles"));
    return Number.isFinite(saved) && saved >= 1 && saved <= 20 ? saved : 5;
  });
  const [minCycles, setMinCycles] = useState<number>(() => {
    const saved = Number(localStorage.getItem("cr.minCycles"));
    return Number.isFinite(saved) && saved >= 1 && saved <= 20 ? saved : 2;
  });
  const [drafts, setDrafts] = useState<DraftFile[]>([]);
  // 报告语言：用户没选过时跟随界面语言，选过则记住
  const [savedLang, setSavedLang] = useState<Lang | null>(() => {
    const saved = localStorage.getItem("cr.reportLang");
    return saved === "zh" || saved === "en" ? saved : null;
  });
  const reportLang = savedLang ?? lang;
  const [askLoop, setAskLoop] = useState(() => localStorage.getItem("cr.askLoop") !== "0"); // 默认开
  const [decision, setDecision] = useState<LoopDecision | null>(null); // 后端正在等用户决定「是否再改一轮」
  const settings = useSettings();
  const [modelChoice, setModelChoice] = useState<ModelChoice>(DEFAULT_CHOICE); // 本次研究的模型；默认用设置里的默认提供方

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTsRef = useRef<number>(0);
  const lastStatusRef = useRef<string>("");
  const snapshotRef = useRef<StreamEvent["data"] | null>(null);
  const finalSeenRef = useRef(false);
  const elapsedRef = useRef(0);
  elapsedRef.current = elapsed;

  const addLog = useCallback((type: LogLine["type"], text: string) => {
    setLogs((p) => [...p.slice(-200), { type, text }]);
  }, []);

  // Load sessions
  const loadSessions = useCallback(async () => {
    try {
      const r = await research.sessions();
      setSessions(r.sessions);
      setSessionTotal(r.total);
    } catch { /* ignore */ }
  }, []);

  const loadMoreSessions = async () => {
    try {
      const r = await research.sessions(sessions.length);
      setSessions((p) => [...p, ...r.sessions]);
      setSessionTotal(r.total);
    } catch { /* ignore */ }
  };

  useEffect(() => { loadSessions(); }, [loadSessions]);

  // Sync work-in-progress guard
  useEffect(() => {
    setWorkInProgress(status === "running" || status === "paused");
    return () => setWorkInProgress(false);
  }, [status]);

  // Timer
  useEffect(() => {
    if (status === "running") {
      startTsRef.current = Date.now() - elapsedRef.current * 1000; // 重连/恢复时从已运行时长继续计时
      timerRef.current = setInterval(() => setElapsed(Math.round((Date.now() - startTsRef.current) / 1000)), 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [status]);

  const finishCompleted = (sessionId?: string) => {
    setStatus("completed");
    setSteps((p) => p.map((s) => ({ ...s, status: "done" as const })));
    addLog("ok", t("research.log.done"));
    if (sessionId) {
      setActiveSessionId(sessionId);
      research.report(sessionId).then((r) => {
        setReport(r.report);
        if (r.confidence_report?.overall_confidence != null) {
          setConfidence(r.confidence_report as ConfidenceReport);
        }
        if (r.token_usage) setUsage(r.token_usage);
      }).catch(() => {});
      research.drafts(sessionId).then(setDrafts).catch(() => setDrafts([]));
    }
    loadSessions();
  };

  const handleStreamEvent = ({ type, data }: StreamEvent) => {
    switch (type) {
      case "snapshot": // 每次（重）连接的第一条：清空后由随后的回放事件重建，避免重复日志
        snapshotRef.current = data;
        finalSeenRef.current = false;
        lastStatusRef.current = "";
        setSteps(initSteps());
        setLogs([]);
        setStreamText("");
        setStreamDone(false);
        setUsage(null);
        setConfidence(null);
        setDecision(data.loop_decision ? toDecision(data.loop_decision) : null); // 重连时仍在等决定：从快照恢复提示卡
        setElapsed(data.elapsed ?? 0);
        if (data.status === "pending" || data.status === "running") setStatus(data.paused ? "paused" : "running");
        break;
      case "disconnected":
        addLog("warn", t("research.log.disconnected", { n: data.retry_in }));
        break;
      case "started":
        addLog("info", t("research.log.started", { id: data.task_id }));
        break;
      case "status": {
        const s = data.status || "";
        if (s !== lastStatusRef.current) {
          lastStatusRef.current = s;
          addLog("info", `◆ ${s}`);
        }
        const stepKey = STATUS_TO_STEP[s.toLowerCase()];
        if (stepKey) setSteps((p) => advanceSteps(p, stepKey));
        break;
      }
      case "stream_start":
        setStreamText("");
        setStreamAgent(data.agent || "");
        setStreamDone(false);
        break;
      case "stream_chunk":
        setStreamText((p) => p + (data.chunk || ""));
        break;
      case "stream_end":
        setStreamDone(true); // Keep text visible, just stop the cursor
        break;
      case "plan":
        addLog("ok", t("research.log.plan", { n: data.total_queries ?? "?" }));
        break;
      case "cycle_start":
        addLog("info", t("research.log.cycle", { n: data.cycle }));
        break;
      case "review":
        addLog("ok", t("research.log.review", { n: data.avg_score?.toFixed(1) ?? "?" }));
        break;
      case "loop_decision":
        setDecision(toDecision(data));
        addLog("warn", t("research.log.loopAsked", { n: data.cycle }));
        break;
      case "loop_decision_timer":
        setDecision((p) => (p ? withTimer(p, data) : p));
        break;
      case "loop_decision_resolved": {
        setDecision(null);
        const logKey: Record<string, TKey> = { continue: "research.log.loopContinue", stop: "research.log.loopStop", timeout: "research.log.loopTimeout" };
        if (logKey[data.choice]) addLog("info", t(logKey[data.choice])); // aborted（任务被停止）不记
        break;
      }
      case "confidence_report":
        setConfidence(data as ConfidenceReport);
        break;
      case "token_usage":
        setUsage((p) => addUsage(p, data));
        break;
      case "heartbeat":
        setElapsed(data.elapsed ?? 0);
        break;
      case "completed":
        finalSeenRef.current = true;
        clearActiveTask();
        finishCompleted(data.session_id);
        break;
      case "error":
        finalSeenRef.current = true;
        clearActiveTask();
        setStatus("error");
        addLog("err", t("research.log.error", { msg: data.message }));
        break;
      case "end": {
        // 没有 completed/error 就收到 end：任务早已结束（服务重启或停止后订阅），按快照里的状态收尾
        clearActiveTask();
        if (finalSeenRef.current) break;
        const snap = snapshotRef.current;
        if (snap?.status === "completed") finishCompleted(snap.session_id);
        else if (snap?.status === "failed") { setStatus("error"); addLog("err", t("research.log.error", { msg: snap.error ?? "" })); }
        else { setStatus("idle"); addLog("warn", t("research.log.interrupted")); }
        break;
      }
    }
  };

  const { connect: connectSSE, disconnect } = useTaskStream(handleStreamEvent);

  // 页面加载时重连仍在运行的任务（刷新页面、重新打开标签页）
  useEffect(() => {
    const id = loadActiveTask();
    if (!id) return;
    let cancelled = false;
    research.status(id).then((s) => {
      if (cancelled) return;
      if (s.status !== "running" && s.status !== "pending") { clearActiveTask(); return; }
      setTaskId(id);
      setQuestion(String(s.question ?? ""));
      setStatus(s.paused ? "paused" : "running");
      connectSSE(id);
    }).catch(() => clearActiveTask());
    return () => { cancelled = true; };
  }, [connectSSE]);

  const resetRun = () => {
    setSteps(initSteps());
    setLogs([]);
    setReport(null);
    setConfidence(null);
    setUsage(null);
    setStreamText("");
    setStreamDone(false);
    lastStatusRef.current = "";
    setElapsed(0);
    setDecision(null);
    setStatus("running");
  };

  const handleReplay = async (fromPhase: string | null) => {
    if (!activeSessionId) return;
    resetRun();
    addLog("info", t("research.log.replaying"));
    try {
      const { task_id } = await research.replay(activeSessionId, fromPhase);
      setTaskId(task_id);
      saveActiveTask(task_id);
      connectSSE(task_id);
    } catch (err: unknown) {
      setStatus("error");
      toast.error(err instanceof Error ? err.message : t("research.toast.replayFailed"));
    }
  };

  const handleStart = async () => {
    if (!question.trim() || status === "running") return;
    resetRun();
    addLog("info", t("research.log.starting"));
    try {
      const effMin = Math.min(Math.max(1, minCycles | 0), 20);
      const effMax = Math.min(Math.max(effMin, maxCycles | 0), 20);
      localStorage.setItem("cr.depth", depth);
      if (depth === "custom") {
        localStorage.setItem("cr.minCycles", String(effMin));
        localStorage.setItem("cr.maxCycles", String(effMax));
      }
      const { task_id } = await research.start(question.trim(), {
        clarification: clarification.trim() || undefined,
        language: reportLang,
        ask_loop: askLoop,
        ...modelRequest(modelChoice),
        ...(depth === "custom" ? { min_cycles: effMin, max_cycles: effMax } : { depth }),
      });
      setTaskId(task_id);
      saveActiveTask(task_id);
      connectSSE(task_id);
    } catch (err: unknown) {
      setStatus("error");
      toast.error(err instanceof Error ? err.message : t("research.toast.startFailed"));
    }
  };

  const handleStop = async () => {
    if (!taskId) return;
    try { await research.stop(taskId); } catch { /* ignore */ }
    setStatus("idle");
    setTaskId(null);
    disconnect();
    clearActiveTask();
    addLog("warn", t("research.log.stopped"));
  };

  const handleLoopChoice = async (choice: "continue" | "stop") => {
    if (!taskId) return;
    try { await research.loopDecision(taskId, choice); setDecision(null); }
    catch (err: unknown) {
      setDecision(null); // 409：已经决定过或已超时，提示卡不再有意义
      toast.error(err instanceof Error ? err.message : t("research.toast.loopFailed"));
    }
  };

  const handlePauseResume = async () => {
    if (!taskId) return;
    if (status === "paused") {
      await research.resume(taskId);
      setStatus("running");
      addLog("info", t("research.log.resumed"));
    } else {
      await research.pause(taskId);
      setStatus("paused");
      addLog("warn", t("research.log.paused"));
    }
  };

  const handleInject = async () => {
    if (!taskId || !injectMsg.trim()) return;
    await research.inject(taskId, injectMsg.trim());
    setInjectMsg("");
    addLog("info", t("research.log.injected", { msg: injectMsg }));
  };

  const handleLoadSession = async (s: SessionMeta) => {
    setActiveSessionId(sessionKey(s));
    if (s.status === "running") return; // 运行中的任务由当前页面的进度区呈现，这里只切换历史面板
    setQuestion(s.question);
    setReport(null);
    setConfidence(null);
    setDrafts([]);
    setUsage(null);
    if (s.status && s.status !== "completed" && s.status !== "unknown") { // 失败/停止/中断：没有最终报告，只展示原因与阶段记录
      const failed = s.status === "failed";
      setStatus(failed ? "error" : "idle");
      setSteps(initSteps());
      setLogs(failed ? [{ type: "err", text: t("research.log.error", { msg: s.error ?? "" }) }] : []);
      return;
    }
    setStatus("completed");
    setSteps((p) => p.map((st) => ({ ...st, status: "done" as const })));
    try {
      const r = await research.report(s.session_id);
      setReport(r.report);
      setUsage(r.token_usage);
      if (r.confidence_report?.overall_confidence != null) {
        setConfidence(r.confidence_report as ConfidenceReport);
      }
    } catch { toast.error(t("research.toast.loadFailed")); }
    research.drafts(s.session_id).then(setDrafts).catch(() => setDrafts([]));
  };

  const handleDeleteSession = async (e: React.MouseEvent, s: SessionMeta) => {
    e.stopPropagation();
    const key = sessionKey(s);
    try {
      if (s.session_id) await research.deleteSession(s.session_id);
      else await research.stop(s.task_id ?? ""); // 没有工作空间的任务：DELETE /research/{task_id} 清掉任务记录
      setSessions((p) => p.filter((x) => sessionKey(x) !== key));
      setSessionTotal((n) => Math.max(0, n - 1));
      if (activeSessionId === key) { setReport(null); setActiveSessionId(null); setDrafts([]); setUsage(null); }
      toast.success(t("research.toast.deleted"));
    } catch { toast.error(t("research.toast.deleteFailed")); }
  };

  const handleCopy = async () => {
    if (!report) return;
    await navigator.clipboard.writeText(report);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const isRunning = status === "running" || status === "paused";
  const hasReport = !!report;

  const handleRestart = (q: string) => {
    setQuestion(q);
    setReport(null);
    setUsage(null);
    setStatus("idle");
    setLogs([]);
    setSteps(initSteps());
    setActiveSessionId(null);
    setStreamText("");
    setStreamDone(false);
    setClarification("");
  };

  const handleStopAll = async () => {
    try { await research.stopAll(); } catch { /* ignore */ }
    if (taskId) { disconnect(); setTaskId(null); }
    clearActiveTask();
    setStatus("idle");
    addLog("warn", t("research.log.stoppedAll"));
  };

  return (
    <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
      {/* Left sidebar */}
      <aside style={{
        width: 240, flexShrink: 0, background: "var(--surface)",
        borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column", overflow: "hidden",
      }}>
        <div style={{ padding: "12px 14px 10px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: ".7px" }}>{t("research.history")}</span>
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            {isRunning && (
              <button
                onClick={handleStopAll}
                title={t("research.stopAll.title")}
                style={{ display: "flex", alignItems: "center", gap: 3, padding: "3px 7px", borderRadius: 5, border: "1px solid rgba(239,68,68,.3)", background: "rgba(239,68,68,.08)", color: "var(--danger)", fontSize: 10, cursor: "pointer", fontWeight: 600 }}
              >
                <Square size={10} />{t("research.stopAll")}
              </button>
            )}
            <button
              onClick={() => { setReport(null); setUsage(null); setStatus("idle"); setQuestion(""); setActiveSessionId(null); setLogs([]); setSteps(initSteps()); }}
              style={{ width: 24, height: 24, borderRadius: 6, border: "none", background: "transparent", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text3)" }}
              title={t("research.new")}
            >
              <Plus size={14} />
            </button>
          </div>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: 8 }}>
          {/* Current running task */}
          {isRunning && (
            <div style={{ padding: "9px 10px", borderRadius: 8, marginBottom: 6, border: "1px solid", borderColor: status === "paused" ? "rgba(245,158,11,.4)" : "var(--accent-border)", background: status === "paused" ? "rgba(245,158,11,.06)" : "var(--accent-dim)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 4 }}>
                <div style={{ width: 6, height: 6, borderRadius: "50%", background: status === "paused" ? "var(--warning)" : "var(--success)", flexShrink: 0, animation: status === "paused" ? "none" : "pulse 1.2s infinite" }} />
                <span style={{ fontSize: 10, fontWeight: 700, color: status === "paused" ? "var(--warning)" : "var(--accent)" }}>{status === "paused" ? t("research.paused") : t("research.running", { n: elapsed })}</span>
              </div>
              <div style={{ fontSize: 12, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginBottom: 6 }}>
                {question.slice(0, 38)}{question.length > 38 ? "…" : ""}
              </div>
              <div style={{ display: "flex", gap: 4 }}>
                <button onClick={handlePauseResume} style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 3, padding: "4px 0", borderRadius: 5, border: "1px solid", borderColor: status === "paused" ? "rgba(16,185,129,.3)" : "rgba(245,158,11,.3)", background: status === "paused" ? "rgba(16,185,129,.08)" : "rgba(245,158,11,.08)", color: status === "paused" ? "var(--success)" : "var(--warning)", fontSize: 11, cursor: "pointer" }}>
                  {status === "paused" ? <><Play size={10} />{t("research.continue")}</> : <><Pause size={10} />{t("research.pause")}</>}
                </button>
                <button onClick={handleStop} style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 3, padding: "4px 0", borderRadius: 5, border: "1px solid rgba(239,68,68,.3)", background: "rgba(239,68,68,.08)", color: "var(--danger)", fontSize: 11, cursor: "pointer" }}>
                  <Square size={10} />{t("research.stop")}
                </button>
              </div>
            </div>
          )}

          {sessions.length === 0 && !isRunning ? (
            <div style={{ padding: "24px 12px", textAlign: "center", color: "var(--text4)", fontSize: 12 }}>
              <div style={{ fontSize: 28, marginBottom: 8, opacity: .5 }}>🔬</div>
              <div>{t("research.empty")}</div>
            </div>
          ) : (
            <SessionList sessions={sessions} total={sessionTotal} activeId={activeSessionId}
              onSelect={handleLoadSession} onRedo={handleRestart} onDelete={handleDeleteSession} onMore={loadMoreSessions} />
          )}
        </div>
      </aside>

      {/* Main */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>

          {isRunning && decision && <LoopDecisionCard decision={decision} onChoose={handleLoopChoice} />}

          {/* Input card */}
          <div style={{ background: "var(--surface)", borderRadius: 14, border: "1px solid var(--border)", padding: 20, marginBottom: 16, boxShadow: "0 1px 3px rgba(184,114,26,.06)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
              <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>{t("research.askTitle")}</span>
              {isRunning && (
                <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text3)" }}>
                  <div style={{ width: 6, height: 6, borderRadius: "50%", background: status === "paused" ? "var(--warning)" : "var(--success)", animation: status === "paused" ? "none" : "pulse 1.2s infinite" }} />
                  {status === "paused" ? t("research.paused") : t("research.running", { n: elapsed })}
                </div>
              )}
            </div>

            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleStart(); }}
              placeholder={t("research.questionPh")}
              disabled={isRunning}
              rows={3}
              style={{
                width: "100%", resize: "vertical", padding: "10px 14px",
                border: "1px solid var(--border)", borderRadius: 10,
                background: "var(--surface2)", color: "var(--text)",
                fontSize: 14, lineHeight: 1.6, outline: "none",
                fontFamily: "inherit", transition: "border-color .15s",
              }}
              onFocus={(e) => { e.target.style.borderColor = "var(--accent)"; e.target.style.boxShadow = "0 0 0 3px var(--accent-dim)"; }}
              onBlur={(e) => { e.target.style.borderColor = "var(--border)"; e.target.style.boxShadow = "none"; }}
            />

            {showClarify && (
              <textarea
                value={clarification}
                onChange={(e) => setClarification(e.target.value)}
                placeholder={t("research.clarifyPh")}
                rows={2}
                style={{ width: "100%", resize: "vertical", padding: "8px 12px", border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg2)", color: "var(--text)", fontSize: 13, outline: "none", fontFamily: "inherit", marginTop: 8 }}
              />
            )}

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 12 }}>
              <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                <button onClick={() => setShowClarify((v) => !v)} style={{ padding: "6px 12px", borderRadius: 7, border: "1px solid var(--border)", background: "transparent", color: "var(--text3)", fontSize: 12, cursor: "pointer" }}>
                  {showClarify ? t("research.clarifyHide") : t("research.clarifyShow")}
                </button>
                {isRunning && (
                  <>
                    <button onClick={handlePauseResume} style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 12px", borderRadius: 7, border: "1px solid", borderColor: status === "paused" ? "rgba(16,185,129,.3)" : "rgba(245,158,11,.3)", background: status === "paused" ? "rgba(16,185,129,.08)" : "rgba(245,158,11,.08)", color: status === "paused" ? "var(--success)" : "var(--warning)", fontSize: 12, cursor: "pointer" }}>
                      {status === "paused" ? <><Play size={12} />{t("research.resume")}</> : <><Pause size={12} />{t("research.pause")}</>}
                    </button>
                    <button onClick={handleStop} style={{ padding: "6px 12px", borderRadius: 7, border: "1px solid rgba(239,68,68,.3)", background: "rgba(239,68,68,.08)", color: "var(--danger)", fontSize: 12, cursor: "pointer" }}>
                      {t("research.terminate")}
                    </button>
                  </>
                )}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", justifyContent: "flex-end", flex: 1, minWidth: 0 }}>
                {!isRunning && <ModelPicker settings={settings} value={modelChoice} onChange={setModelChoice} />}
                {!isRunning && (
                  <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 8px", borderRadius: 7, border: "1px solid var(--border)", background: "var(--surface2)" }}
                       title={t("research.depthTip")}>
                    <select
                      value={depth}
                      onChange={(e) => setDepth(e.target.value as Depth | "custom")}
                      style={{ padding: "3px 4px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--surface)", color: "var(--text)", fontSize: 12 }}
                    >
                      <option value="quick">{t("research.depth.quick")}</option>
                      <option value="standard">{t("research.depth.standard")}</option>
                      <option value="deep">{t("research.depth.deep")}</option>
                      <option value="custom">{t("research.depth.custom")}</option>
                    </select>
                    {depth === "custom" && (<>
                    <input
                      type="number" min={1} max={20} value={minCycles}
                      onChange={(e) => setMinCycles(Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
                      style={{ width: 38, padding: "3px 4px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--surface)", color: "var(--text)", fontSize: 12, textAlign: "center" }}
                    />
                    <span style={{ fontSize: 11, color: "var(--text4)" }}>~</span>
                    <input
                      type="number" min={1} max={20} value={maxCycles}
                      onChange={(e) => setMaxCycles(Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
                      style={{ width: 38, padding: "3px 4px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--surface)", color: "var(--text)", fontSize: 12, textAlign: "center" }}
                    />
                    </>)}
                  </div>
                )}
                {!isRunning && (
                  <div style={{ display: "flex", alignItems: "center", padding: "4px 8px", borderRadius: 7, border: "1px solid var(--border)", background: "var(--surface2)" }}
                       title={t("research.langTip")}>
                    <select
                      value={reportLang}
                      onChange={(e) => { const v = e.target.value as Lang; setSavedLang(v); localStorage.setItem("cr.reportLang", v); }}
                      style={{ padding: "3px 4px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--surface)", color: "var(--text)", fontSize: 12 }}
                    >
                      <option value="zh">{t("research.lang.zh")}</option>
                      <option value="en">{t("research.lang.en")}</option>
                    </select>
                  </div>
                )}
                {!isRunning && (
                  <label style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 8px", borderRadius: 7, border: "1px solid var(--border)", background: "var(--surface2)", fontSize: 12, color: "var(--text2)", cursor: "pointer" }}
                         title={t("research.askLoopTip")}>
                    <input type="checkbox" checked={askLoop}
                           onChange={(e) => { setAskLoop(e.target.checked); localStorage.setItem("cr.askLoop", e.target.checked ? "1" : "0"); }} />
                    {t("research.askLoop")}
                  </label>
                )}
                <span style={{ fontSize: 11, color: "var(--text4)" }}>{t("research.ctrlEnter")}</span>
                {!isRunning ? (
                  <button
                    onClick={handleStart}
                    disabled={!question.trim()}
                    style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 20px", borderRadius: 8, border: "none", background: "linear-gradient(135deg, var(--accent), var(--accent-hover))", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer", boxShadow: "0 2px 8px var(--accent-border)", opacity: question.trim() ? 1 : .5 }}
                  >
                    {t("research.start")}
                  </button>
                ) : null}
              </div>
            </div>

            {/* Inject input */}
            {isRunning && (
              <div style={{ marginTop: 12, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    value={injectMsg}
                    onChange={(e) => setInjectMsg(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleInject(); }}
                    placeholder={t("research.injectPh")}
                    style={{ flex: 1, padding: "7px 10px", borderRadius: 7, border: "1px solid var(--border2)", background: "var(--surface2)", color: "var(--text)", fontSize: 12, outline: "none", fontFamily: "inherit" }}
                  />
                  <button onClick={handleInject} style={{ padding: "7px 14px", borderRadius: 7, border: "none", background: "var(--accent-dim)", color: "var(--accent)", fontSize: 12, cursor: "pointer" }}>{t("research.send")}</button>
                </div>
                <div style={{ fontSize: 10, color: "var(--text4)", marginTop: 4 }}>{t("research.injectHint")}</div>
              </div>
            )}
          </div>

          {/* Progress card */}
          {(isRunning || status === "completed" || status === "error") && (
            <div style={{ background: "var(--surface)", borderRadius: 14, border: "1px solid var(--border)", overflow: "hidden", marginBottom: 16 }}>
              <div style={{ padding: "14px 18px" }}>
                <div style={{ marginBottom: 14 }}>
                  <StepPipeline steps={steps} />
                </div>
                <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: ".5px", marginBottom: 6 }}>{t("research.logTitle")}</div>
                <LogArea lines={logs} />
                <StreamArea text={streamText} agent={streamAgent} done={streamDone} />
              </div>
            </div>
          )}

          {/* Report card */}
          {hasReport && (
            <div style={{ background: "var(--surface)", borderRadius: 14, border: "1px solid var(--border)", overflow: "hidden", marginBottom: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 18px", borderBottom: "1px solid var(--border)", background: "var(--surface2)" }}>
                <span style={{ flex: 1, fontSize: 13, fontWeight: 700, color: "var(--text)" }}>{t("research.reportTitle")}</span>
                <button onClick={handleCopy} style={{ display: "flex", alignItems: "center", gap: 5, padding: "5px 12px", borderRadius: 7, border: "1px solid var(--border2)", background: "var(--surface)", color: "var(--text2)", fontSize: 12, cursor: "pointer" }}>
                  {copied ? <><Check size={12} />{t("research.copied")}</> : <><Copy size={12} />{t("research.copy")}</>}
                </button>
                <button onClick={() => setShowReport((v) => !v)} style={{ width: 28, height: 28, borderRadius: 6, border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text3)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  {showReport ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                </button>
              </div>
              {showReport && (
                <>
                  <ReportBody markdown={report} />
                  <LedgerPanels sessionId={activeSessionId} />
                  {drafts.length > 0 && (
                    <div style={{ borderTop: "1px solid var(--border)", padding: "12px 20px", background: "var(--surface2)" }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: ".5px", marginBottom: 8 }}>
                        {t("research.draftsTitle", { n: drafts.length })}
                      </div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {drafts.map((d) => (
                          <a
                            key={d.name}
                            href={withToken(d.download_url)}
                            download
                            style={{
                              display: "inline-flex", alignItems: "center", gap: 5,
                              padding: "5px 10px", borderRadius: 6,
                              border: "1px solid",
                              borderColor: d.kind === "final" ? "rgba(16,185,129,.3)" : "var(--border)",
                              background: d.kind === "final" ? "rgba(16,185,129,.08)" : "var(--surface)",
                              color: d.kind === "final" ? "var(--success)" : "var(--text2)",
                              fontSize: 12, textDecoration: "none",
                            }}
                            title={`${(d.size / 1024).toFixed(1)} KB · ${new Date(d.modified_at).toLocaleString(locale(lang))}`}
                          >
                            <Download size={11} />
                            {d.kind === "final" ? t("research.draftFinal") : t("research.draftN", { n: d.draft_num ?? "" })}
                            <span style={{ fontSize: 10, color: "var(--text4)" }}>{(d.size / 1024).toFixed(1)}KB</span>
                          </a>
                        ))}
                      </div>
                    </div>
                  )}
                  <div style={{ borderTop: "1px solid var(--border)", padding: "14px 20px", display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
                    <button
                      onClick={() => { const blob = new Blob([report], { type: "text/markdown" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `research-${Date.now()}.md`; a.click(); }}
                      style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 12px", borderRadius: 7, border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text2)", fontSize: 12, cursor: "pointer" }}
                    >
                      <Download size={12} />{t("research.downloadMd")}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {activeSessionId && (
            <SessionHistoryPanel sessionId={activeSessionId} busy={isRunning} onReplay={handleReplay}
              hasWorkspace={sessions.find((s) => sessionKey(s) === activeSessionId)?.session_id !== ""} />
          )}
        </div>

        {/* Right panel */}
        {(confidence || usage) && (
          <aside className="research-confidence-aside" style={{ width: 240, flexShrink: 0, background: "var(--surface)", borderLeft: "1px solid var(--border)", padding: 14, overflowY: "auto" }}>
            {confidence && (<>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: ".6px", marginBottom: 10 }}>{t("research.confidenceTitle")}</div>
            <ConfidenceGauge report={confidence} />
            </>)}
            {confidence?.disputed_claims && confidence.disputed_claims.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: ".6px", marginBottom: 8 }}>{t("research.disputed")}</div>
                {confidence.disputed_claims.map((c, i) => (
                  <div key={i} style={{ padding: "8px 10px", borderRadius: 7, borderLeft: "3px solid var(--warning)", background: "rgba(245,158,11,.05)", marginBottom: 6, fontSize: 11, color: "var(--text2)", lineHeight: 1.5 }}>
                    <div style={{ display: "inline-flex", padding: "1px 6px", borderRadius: 8, fontSize: 9, fontWeight: 700, background: "rgba(245,158,11,.15)", color: "var(--warning)", marginBottom: 3 }}>{c.confidence}</div>
                    <div>{c.claim}</div>
                  </div>
                ))}
              </div>
            )}
            {usage && <UsagePanel usage={usage} />}
          </aside>
        )}
      </div>
    </div>
  );
}
