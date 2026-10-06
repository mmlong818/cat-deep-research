import { useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import { research } from "../../lib/api";
import type { AuditEntry, PhaseLogTask } from "../../lib/types";
import { useT, locale, type Lang, type TFunc, type TKey } from "../../i18n";
import { providerName } from "../../lib/useSettings";
import { STATUS_COLOR, statusLabel } from "./SessionList";

const PHASES = ["clarify", "plan", "research", "sources", "ledger", "analyze", "draft", "improve", "finish"];

const phaseLabel = (t: TFunc, p: unknown) =>
  PHASES.includes(p as string) ? t(`research.phase.${p as string}` as TKey) : String(p);

const USER_KINDS = new Set(["task_created", "user_message", "pause_requested", "resume_requested",
                            "stop_requested", "delete_requested"]);

const KINDS = ["task_created", "user_message", "pause_requested", "resume_requested", "stop_requested",
               "delete_requested", "user_message_ack", "checkpoint", "loop_stop", "final_selected", "task_finished"];

function summary(e: AuditEntry, t: TFunc): string {
  const p = e.payload as Record<string, string | number | undefined>;
  switch (e.kind) {
    case "task_created": {
      const model = p.provider ? ` · ${providerName(String(p.provider))} ${p.core_model ?? ""} / ${p.support_model ?? ""}` : "";
      return (p.source === "replay" ? t("research.hist.replayStart", { p: phaseLabel(t, p.from_phase) })
        : `${p.source === "clarify" ? t("research.hist.createdClarified") : t("research.hist.createdDirect")}${p.depth ? ` · ${p.depth}` : ""}`) + model;
    }
    case "user_message": return String(p.message ?? "");
    case "checkpoint": return phaseLabel(t, p.phase);
    case "loop_stop": return t("research.hist.loopStop", { n: p.cycle ?? "", r: p.reason ?? "" });
    case "final_selected": return p.reason
      ? t("research.hist.finalDraftReason", { n: p.draft ?? "", r: p.reason })
      : t("research.hist.finalDraft", { n: p.draft ?? "" });
    case "task_finished": return p.error
      ? t("research.hist.finishedErr", { s: p.status ?? "", e: p.error })
      : String(p.status ?? "");
    default: return "";
  }
}

const fmtTime = (iso: string | null, lang: Lang) => (iso ? new Date(iso).toLocaleTimeString(locale(lang)) : "…");

/** 各任务的阶段记录（一个会话可有原任务与多个重放任务）；失败的阶段标红并显示原因。 */
function PhaseLog({ tasks }: { tasks: PhaseLogTask[] }) {
  const { t, lang } = useT();
  if (tasks.length === 0) return <div style={{ fontSize: 12, color: "var(--text4)", marginBottom: 12 }}>{t("research.hist.noPhases")}</div>;
  return (
    <div style={{ maxHeight: 220, overflowY: "auto", marginBottom: 12 }}>
      {tasks.map((task) => (
        <div key={task.task_id} style={{ marginBottom: 6 }}>
          {(tasks.length > 1 || task.replay_from) && (
            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text3)" }}>
              {task.replay_from
                ? t("research.hist.phaseTaskReplay", { id: task.task_id, p: phaseLabel(t, task.replay_from) })
                : t("research.hist.phaseTask", { id: task.task_id })}
              <span style={{ marginLeft: 6, color: STATUS_COLOR[task.status] }}>{statusLabel(t, task.status)}</span>
            </div>
          )}
          {task.phases.map((p, i) => (
            <div key={i} style={{ display: "flex", flexWrap: "wrap", gap: 8, fontSize: 12, lineHeight: 1.7, color: p.status === "failed" ? "var(--danger)" : "var(--text2)" }}>
              <span style={{ fontFamily: "monospace", fontSize: 11, color: "var(--text4)", flexShrink: 0 }}>
                {fmtTime(p.started_at, lang)} – {fmtTime(p.finished_at, lang)}
              </span>
              <span style={{ fontWeight: 600, flexShrink: 0 }}>{p.phase_key ? phaseLabel(t, p.phase_key) : p.phase}</span>
              <span style={{ flexShrink: 0, color: STATUS_COLOR[p.status] }}>{statusLabel(t, p.status)}</span>
              {p.error && <span style={{ wordBreak: "break-word" }}>{p.error}</span>}
            </div>
          ))}
          {task.error && !task.phases.some((p) => p.error) && (
            <div style={{ fontSize: 12, color: "var(--danger)", wordBreak: "break-word" }}>{task.error}</div>
          )}
        </div>
      ))}
    </div>
  );
}

const btn = { display: "flex", alignItems: "center", gap: 5, padding: "5px 10px", borderRadius: 7, border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text2)", fontSize: 12, cursor: "pointer" } as const;

/** 会话的重放入口与审计时间线；busy 时禁用重放，变化时刷新数据。 */
export function SessionHistoryPanel({ sessionId, busy, hasWorkspace = true, onReplay }: {
  sessionId: string; busy: boolean; hasWorkspace?: boolean; onReplay: (fromPhase: string | null) => void;
}) {
  const { t, lang } = useT();
  const [phases, setPhases] = useState<string[]>([]);
  const [done, setDone] = useState<string[]>([]);
  const [resumeFrom, setResumeFrom] = useState<string | null>(null);
  const [fromPhase, setFromPhase] = useState("");
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [phaseLog, setPhaseLog] = useState<PhaseLogTask[]>([]);

  useEffect(() => {
    // 没建成工作空间的失败任务（sessionId 是 task_id）没有检查点，只有阶段记录与审计
    if (hasWorkspace) research.checkpoints(sessionId).then((c) => {
      const finished = c.checkpoints.map((x) => x.phase);
      setPhases(c.phases);
      setDone(finished);
      setResumeFrom(c.resume_from);
      setFromPhase(c.phases[Math.min(finished.length, c.phases.length - 1)] ?? "");
    }).catch(() => { setDone([]); setResumeFrom(null); });
    research.audit(sessionId).then((a) => setEntries(a.entries)).catch(() => setEntries([]));
    research.phaseLog(sessionId).then((l) => setPhaseLog(l.tasks)).catch(() => setPhaseLog([]));
  }, [sessionId, busy, hasWorkspace]);

  // 第 i 阶段可重放的前提是第 i-1 阶段有检查点；澄清阶段不可重放
  const replayable = phases.filter((_, i) => i > 0 && i <= done.length);

  return (
    <div style={{ background: "var(--surface)", borderRadius: 14, border: "1px solid var(--border)", padding: "12px 18px", marginBottom: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", marginBottom: 10 }}>{t("research.hist.title")}</div>
      {replayable.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <select value={fromPhase} onChange={(e) => setFromPhase(e.target.value)} disabled={busy}
                  style={{ padding: "4px 6px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface)", color: "var(--text)", fontSize: 12 }}>
            {replayable.map((p) => <option key={p} value={p}>{phaseLabel(t, p)}</option>)}
          </select>
          <button style={btn} disabled={busy || !fromPhase} onClick={() => onReplay(fromPhase)}>
            <RotateCcw size={12} />{t("research.hist.replayFrom")}
          </button>
          {resumeFrom && (
            <button style={btn} disabled={busy} onClick={() => onReplay(null)}>
              {t("research.hist.resumeFrom", { p: phaseLabel(t, resumeFrom) })}
            </button>
          )}
          <span style={{ fontSize: 11, color: "var(--text4)" }}>{t("research.hist.rollbackHint")}</span>
        </div>
      )}
      <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text3)", marginBottom: 6 }}>{t("research.hist.phaseLog")}</div>
      <PhaseLog tasks={phaseLog} />
      <div style={{ maxHeight: 240, overflowY: "auto" }}>
        {entries.length === 0 && <div style={{ fontSize: 12, color: "var(--text4)" }}>{t("research.hist.noAudit")}</div>}
        {entries.map((e, i) => (
          <div key={i} style={{ display: "flex", gap: 8, fontSize: 12, lineHeight: 1.7, color: "var(--text2)" }}>
            <span style={{ fontFamily: "monospace", fontSize: 11, color: "var(--text4)", flexShrink: 0 }}>
              {new Date(e.created_at).toLocaleTimeString(locale(lang))}
            </span>
            <span style={{ fontWeight: 600, flexShrink: 0, color: USER_KINDS.has(e.kind) ? "var(--accent)" : "var(--text3)" }}>
              {KINDS.includes(e.kind) ? t(`research.kind.${e.kind}` as TKey) : e.kind}
            </span>
            <span style={{ wordBreak: "break-word" }}>{summary(e, t)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
