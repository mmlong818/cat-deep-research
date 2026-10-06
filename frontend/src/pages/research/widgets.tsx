import { useEffect, useRef } from "react";
import type { PipelineStep, LogLine, ConfidenceReport } from "../../lib/types";
import { useT, type TKey } from "../../i18n";

// ── Pipeline steps config ──────────────────────────────────────────────────

const STEP_DEFS = [
  { key: "clarify", label: "research.step.clarify", emoji: "🔍" },
  { key: "plan", label: "research.step.plan", emoji: "📋" },
  { key: "research", label: "research.step.research", emoji: "🌐" },
  { key: "analyze", label: "research.step.analyze", emoji: "🔬" },
  { key: "write", label: "research.step.write", emoji: "✍️" },
  { key: "review", label: "research.step.review", emoji: "⭐" },
  { key: "verify", label: "research.step.verify", emoji: "✅" },
];

export const STATUS_TO_STEP: Record<string, string> = {
  clarifying: "clarify", clarification: "clarify",
  planning: "plan", plan: "plan",
  researching: "research", searching: "research",
  analyzing: "analyze", analysis: "analyze",
  writing: "write", drafting: "write",
  reviewing: "review", improving: "review",
  verifying: "verify", "source_verifying": "verify", fact_checking: "verify",
  completed: "verify",
};

export function initSteps(): PipelineStep[] {
  return STEP_DEFS.map((s) => ({ ...s, status: "pending" as const }));
}

export function advanceSteps(steps: PipelineStep[], activeKey: string): PipelineStep[] {
  const idx = steps.findIndex((s) => s.key === activeKey);
  if (idx < 0) return steps;
  return steps.map((s, i) => ({
    ...s,
    status: i < idx ? "done" : i === idx ? "active" : "pending",
  }));
}

// ── Sub-components ─────────────────────────────────────────────────────────

export function StepPipeline({ steps }: { steps: PipelineStep[] }) {
  const { t } = useT();
  return (
    <div style={{ display: "flex", gap: 2, alignItems: "flex-start" }}>
      {steps.map((s, i) => (
        <div key={s.key} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4, position: "relative", padding: "4px 2px" }}>
          {i < steps.length - 1 && (
            <div style={{
              position: "absolute", right: -2, top: 16, width: 4, height: 2,
              background: s.status === "done" ? "var(--success)" : s.status === "active" ? "var(--accent)" : "var(--border)",
            }} />
          )}
          <div style={{
            width: 30, height: 30, borderRadius: "50%",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 14, border: "2px solid",
            background: s.status === "done" ? "rgba(16,185,129,.1)"
              : s.status === "active" ? "var(--accent)"
              : s.status === "error" ? "rgba(239,68,68,.1)"
              : "var(--surface2)",
            borderColor: s.status === "done" ? "var(--success)"
              : s.status === "active" ? "var(--accent)"
              : s.status === "error" ? "var(--danger)"
              : "var(--border)",
            animation: s.status === "active" ? "pulse 1.6s infinite" : "none",
          }}>
            {s.status === "done" ? "✓" : s.emoji}
          </div>
          <span style={{
            fontSize: 9, fontWeight: 600, color: s.status === "pending" ? "var(--text3)" : "var(--text)",
            whiteSpace: "nowrap",
          }}>{t(s.label as TKey)}</span>
          {s.duration && <span style={{ fontSize: 9, color: "var(--text4)", fontFamily: "monospace" }}>{s.duration}s</span>}
        </div>
      ))}
    </div>
  );
}

export function LogArea({ lines }: { lines: LogLine[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.scrollTo(0, ref.current.scrollHeight); }, [lines]);
  const colors = { info: "var(--accent)", ok: "var(--success)", warn: "var(--warning)", err: "var(--danger)", dim: "var(--text4)" };
  return (
    <div ref={ref} style={{
      background: "var(--bg)", borderRadius: 8, border: "1px solid var(--border)",
      padding: "8px 12px", height: 120, overflowY: "auto",
      fontSize: 11, fontFamily: "'SF Mono', 'Fira Code', monospace", lineHeight: 1.7, color: "var(--text2)",
    }}>
      {lines.map((l, i) => (
        <div key={i} style={{ color: colors[l.type] }}>{l.text}</div>
      ))}
    </div>
  );
}

export function StreamArea({ text, agent, done }: { text: string; agent: string; done: boolean }) {
  const { t } = useT();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.scrollTo(0, ref.current.scrollHeight); }, [text]);
  if (!text) return null;
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: ".6px", flex: 1 }}>{t("research.streamTitle")}</span>
        {agent && <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 10, background: "var(--accent-dim)", color: "var(--accent)", border: "1px solid var(--accent-border)" }}>{agent}</span>}
        {done && <span style={{ fontSize: 10, color: "var(--success)", fontWeight: 700 }}>{t("research.streamDone")}</span>}
      </div>
      <div ref={ref} style={{
        background: "#1a1008", borderRadius: 8, border: "1px solid var(--accent-border)",
        padding: "10px 13px", height: 200, overflowY: "auto",
        fontSize: 12, fontFamily: "'SF Mono', 'Fira Code', monospace",
        lineHeight: 1.75, color: "#c9d1d9", whiteSpace: "pre-wrap", wordBreak: "break-word",
      }}>
        {text}
        {!done && <span style={{ display: "inline-block", width: 7, height: 12, background: "var(--accent)", verticalAlign: "text-bottom", marginLeft: 2, animation: "blink .9s step-end infinite", borderRadius: 1 }} />}
      </div>
    </div>
  );
}

export function ConfidenceGauge({ report }: { report: ConfidenceReport }) {
  const { t } = useT();
  const toPct = (v: unknown) => {
    const n = typeof v === "number" ? v : 0;
    return Math.round((n <= 1 ? n * 100 : n));
  };
  const pct = toPct(report.overall_confidence);
  const color = pct >= 75 ? "var(--success)" : pct >= 50 ? "var(--warning)" : "var(--danger)";
  const bd = report.breakdown ?? {};
  const bars = [
    { label: `${t("research.conf.source")}${bd.source_quality?.weight ? ` · ${bd.source_quality.weight}` : ""}`, val: toPct(bd.source_quality?.score) },
    { label: `${t("research.conf.fact")}${bd.fact_accuracy?.weight ? ` · ${bd.fact_accuracy.weight}` : ""}`, val: toPct(bd.fact_accuracy?.score) },
    { label: `${t("research.conf.conclusion")}${bd.conclusion_validity?.weight ? ` · ${bd.conclusion_validity.weight}` : ""}`, val: toPct(bd.conclusion_validity?.score) },
  ];
  return (
    <div>
      <div style={{ textAlign: "center", padding: "12px 0 6px" }}>
        <div style={{ fontSize: 36, fontWeight: 800, color }}>{pct}%</div>
        <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 2 }}>{t("research.conf.overall")}</div>
      </div>
      <div style={{ marginTop: 12 }}>
        {bars.map((b) => (
          <div key={b.label} style={{ marginBottom: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
              <span style={{ fontSize: 11, color: "var(--text2)" }}>{b.label}</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: "var(--accent)" }}>{b.val}%</span>
            </div>
            <div style={{ height: 5, background: "var(--border)", borderRadius: 3, overflow: "hidden" }}>
              <div style={{ height: "100%", borderRadius: 3, background: `linear-gradient(90deg, var(--accent), var(--accent-hover))`, width: `${b.val}%`, transition: "width 1s" }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
