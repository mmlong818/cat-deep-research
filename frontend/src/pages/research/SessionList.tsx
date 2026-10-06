import { RotateCcw, Trash2 } from "lucide-react";
import type { SessionMeta } from "../../lib/types";
import { useT, locale, type TFunc, type TKey } from "../../i18n";
import { providerName } from "../../lib/useSettings";

const STATUSES = ["running", "completed", "failed", "stopped", "interrupted"];

export const STATUS_COLOR: Record<string, string> = {
  running: "var(--accent)", completed: "var(--success)", failed: "var(--danger)",
  stopped: "var(--warning)", interrupted: "var(--warning)",
};

export const statusLabel = (t: TFunc, s: string) =>
  STATUSES.includes(s) ? t(`research.sess.${s}` as TKey) : s;

/** 会话的列表键：没建成工作空间的失败任务没有 session_id，用 task_id 代替。 */
export const sessionKey = (s: SessionMeta) => s.session_id || s.task_id || "";

const DEPTHS = ["quick", "standard", "deep"];

const chip = { fontSize: 10, color: "var(--text3)" } as const;

function Meta({ s }: { s: SessionMeta }) {
  const { t, lang } = useT();
  const status = s.status ?? "";
  const depth = s.depth && DEPTHS.includes(s.depth) ? t(`research.depth.${s.depth}` as TKey) : s.depth;
  const language = s.language === "zh" || s.language === "en" ? t(`research.lang.${s.language}` as TKey) : null;
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={chip}>{s.created_at ? new Date(s.created_at).toLocaleDateString(locale(lang)) : ""}</span>
        {STATUSES.includes(status) && (
          <span style={{ fontSize: 10, fontWeight: 700, color: STATUS_COLOR[status] }}>● {statusLabel(t, status)}</span>
        )}
        {s.final_score != null && (
          <span style={{
            fontSize: 10, fontWeight: 700, padding: "1px 5px", borderRadius: 8,
            background: s.final_score >= 8 ? "rgba(16,185,129,.12)" : s.final_score >= 6 ? "rgba(245,158,11,.12)" : "rgba(239,68,68,.1)",
            color: s.final_score >= 8 ? "var(--success)" : s.final_score >= 6 ? "var(--warning)" : "var(--danger)",
          }}>{s.final_score.toFixed(1)}</span>
        )}
      </div>
      {(depth || language) && (
        <div style={{ ...chip, marginTop: 2 }}>{[depth, language].filter(Boolean).join(" · ")}</div>
      )}
      {s.provider && (
        <div title={[s.core_model, s.support_model].filter(Boolean).join(" / ")}
             style={{ ...chip, marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {[providerName(s.provider), s.core_model].filter(Boolean).join(" · ")}
        </div>
      )}
      {status === "failed" && s.error && (
        <div title={s.error} style={{ fontSize: 10, color: "var(--danger)", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {s.error}
        </div>
      )}
    </>
  );
}

const actionBtn = { width: 22, height: 22, borderRadius: 4, border: "1px solid var(--border)", background: "var(--surface)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" } as const;

/** 研究页左侧的历史会话列表：状态徽章、深度、语言，失败的显示错误摘要（悬浮看全文）。 */
export function SessionList({ sessions, total, activeId, onSelect, onRedo, onDelete, onMore }: {
  sessions: SessionMeta[]; total: number; activeId: string | null;
  onSelect: (s: SessionMeta) => void;
  onRedo: (question: string) => void;
  onDelete: (e: React.MouseEvent, s: SessionMeta) => void;
  onMore: () => void;
}) {
  const { t } = useT();
  const setHover = (el: HTMLDivElement, on: boolean, active: boolean) => {
    if (!active) {
      el.style.background = on ? "var(--bg2)" : "transparent";
      el.style.borderColor = on ? "var(--border)" : "transparent";
    }
    const btns = el.querySelector(".item-actions") as HTMLElement | null;
    if (btns) btns.style.opacity = on ? "1" : "0";
  };
  return (
    <>
      {sessions.map((s) => {
        const key = sessionKey(s);
        const active = activeId === key;
        return (
          <div
            key={key}
            onClick={() => onSelect(s)}
            style={{
              padding: "9px 10px", borderRadius: 8, cursor: "pointer",
              marginBottom: 3, border: "1px solid",
              borderColor: active ? "var(--accent-border)" : "transparent",
              background: active ? "var(--accent-dim)" : "transparent",
              transition: "all .15s", position: "relative",
            }}
            onMouseEnter={(e) => setHover(e.currentTarget, true, active)}
            onMouseLeave={(e) => setHover(e.currentTarget, false, active)}
          >
            <div style={{ fontSize: 12, fontWeight: 500, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginBottom: 3, paddingRight: 4 }}>
              {s.question.slice(0, 38)}{s.question.length > 38 ? "…" : ""}
            </div>
            <Meta s={s} />
            <div className="item-actions" style={{ position: "absolute", top: 6, right: 6, opacity: 0, display: "flex", gap: 3, transition: "opacity .15s" }}>
              <button onClick={(e) => { e.stopPropagation(); onRedo(s.question); }} title={t("research.redo")}
                      style={{ ...actionBtn, color: "var(--accent)" }}>
                <RotateCcw size={11} />
              </button>
              <button onClick={(e) => onDelete(e, s)} title={t("research.delete")}
                      style={{ ...actionBtn, color: "var(--text4)" }}>
                <Trash2 size={11} />
              </button>
            </div>
          </div>
        );
      })}
      {total > sessions.length && (
        <button onClick={onMore} style={{ width: "100%", padding: "6px 0", marginTop: 4, borderRadius: 6, border: "1px solid var(--border)", background: "transparent", color: "var(--text3)", fontSize: 11, cursor: "pointer" }}>
          {t("research.sess.loadMore", { n: total - sessions.length })}
        </button>
      )}
    </>
  );
}
