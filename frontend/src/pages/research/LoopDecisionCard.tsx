import { useEffect, useState } from "react";
import { useT } from "../../i18n";

/** 后端 loop_decision 事件（及快照里的 loop_decision）；at 是前端收到的时刻，倒计时据此推算，不依赖两端时钟一致。 */
export interface LoopDecision {
  cycle: number;
  max_cycles: number;
  best_draft: number;
  best_score: number;
  gain: number | null;
  violations: number;
  est_seconds: number | null;
  est_cost_usd: number | null;
  remaining_s: number;
  paused: boolean;
  at: number;
}

export const toDecision = (d: Record<string, any>): LoopDecision => ({
  cycle: d.cycle, max_cycles: d.max_cycles, best_draft: d.best_draft, best_score: d.best_score,
  gain: d.gain ?? null, violations: d.violations ?? 0,
  est_seconds: d.est_seconds ?? null, est_cost_usd: d.est_cost_usd ?? null,
  remaining_s: d.remaining_s ?? d.timeout_s ?? 0, paused: !!d.paused, at: Date.now(),
});

/** loop_decision_timer：暂停/恢复时后端给出新的剩余秒数 */
export const withTimer = (d: LoopDecision, e: Record<string, any>): LoopDecision =>
  ({ ...d, remaining_s: e.remaining_s ?? d.remaining_s, paused: !!e.paused, at: Date.now() });

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

const stat = (label: string, value: string) => (
  <div style={{ minWidth: 110 }}>
    <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: ".4px", marginBottom: 2 }}>{label}</div>
    <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>{value}</div>
  </div>
);

/** 改进循环里的「还要继续吗」提示卡：显示当前最优分、提升、违规数、预计再一轮的用时/费用与倒计时。 */
export function LoopDecisionCard({ decision, onChoose }: {
  decision: LoopDecision; onChoose: (choice: "continue" | "stop") => void;
}) {
  const { t } = useT();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (decision.paused) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [decision.paused, decision.at]);

  const left = decision.paused ? decision.remaining_s : Math.max(0, decision.remaining_s - (now - decision.at) / 1000);
  const expired = !decision.paused && left <= 0;
  if (expired && now - decision.at > (decision.remaining_s + 5) * 1000) return null; // 后端的 resolved 事件没收到时的兜底
  const gain = decision.gain == null ? "—" : `${decision.gain >= 0 ? "+" : ""}${decision.gain.toFixed(2)}`;
  const min = decision.est_seconds == null ? null : Math.max(1, Math.round(decision.est_seconds / 60));
  const eta = min == null ? "—"
    : decision.est_cost_usd == null ? t("research.loop.etaTime", { min })
    : t("research.loop.etaTimeCost", { min, cost: decision.est_cost_usd.toFixed(2) });
  const button = (primary: boolean) => ({
    padding: "9px 18px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: expired ? "default" : "pointer", opacity: expired ? .5 : 1,
    border: primary ? "none" : "1px solid var(--border2)",
    background: primary ? "linear-gradient(135deg, var(--accent), var(--accent-hover))" : "var(--surface)",
    color: primary ? "#fff" : "var(--text)",
  } as const);

  return (
    <div role="alertdialog" aria-live="assertive" data-testid="loop-decision-card" style={{
      background: "var(--surface)", borderRadius: 14, border: "2px solid var(--accent)", padding: "16px 20px", marginBottom: 16,
      boxShadow: "0 4px 18px var(--accent-border)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <div style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--accent)", animation: decision.paused ? "none" : "pulse 1.2s infinite" }} />
        <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>{t("research.loop.title")}</span>
      </div>
      <div style={{ fontSize: 12, color: "var(--text3)", marginBottom: 12 }}>
        {t("research.loop.sub", { cycle: decision.cycle, max: decision.max_cycles })}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "10px 28px", marginBottom: 14 }}>
        {stat(t("research.loop.best"), t("research.loop.bestValue", { score: decision.best_score.toFixed(1), draft: decision.best_draft }))}
        {stat(t("research.loop.gain"), gain)}
        {stat(t("research.loop.violations"), t("research.loop.violationsValue", { n: decision.violations }))}
        {stat(t("research.loop.eta"), eta)}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
        <button disabled={expired} onClick={() => onChoose("continue")} style={button(true)}>{t("research.loop.again")}</button>
        <button disabled={expired} onClick={() => onChoose("stop")} style={button(false)}>{t("research.loop.finish")}</button>
        <span data-testid="loop-countdown" style={{ fontSize: 12, color: decision.paused ? "var(--warning)" : "var(--text3)", marginLeft: 4 }}>
          {expired ? t("research.loop.timedOut")
            : t(decision.paused ? "research.loop.countdownPaused" : "research.loop.countdown", { time: clock(left) })}
        </span>
      </div>
    </div>
  );
}
