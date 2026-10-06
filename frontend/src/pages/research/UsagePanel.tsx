import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { TokenUsage } from "../../lib/types";
import { useT, locale } from "../../i18n";

/** 把一次智能体调用的 token_usage 事件累加进总用量（运行中实时统计）。 */
export function addUsage(prev: TokenUsage | null, data: Record<string, unknown>): TokenUsage {
  const base: TokenUsage = prev ?? { total_input: 0, total_output: 0, cost_usd: 0, by_agent: {} };
  const input = Number(data.total_input) || 0;
  const output = Number(data.total_output) || 0;
  const cost = Number(data.cost_usd) || 0;
  const agent = String(data.agent ?? "unknown");
  const cur = base.by_agent[agent] ?? { input: 0, output: 0, cost_usd: 0 };
  return {
    total_input: base.total_input + input,
    total_output: base.total_output + output,
    cost_usd: base.cost_usd + cost,
    by_agent: { ...base.by_agent, [agent]: { input: cur.input + input, output: cur.output + output, cost_usd: cur.cost_usd + cost } },
  };
}

const usd = (v: number) => `$${v.toFixed(v >= 1 ? 2 : 4)}`;

const labelStyle = { fontSize: 11, color: "var(--text3)" } as const;
const valueStyle = { fontSize: 12, fontWeight: 700, color: "var(--text)" } as const;

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 5 }}>
      <span style={labelStyle}>{label}</span>
      <span style={valueStyle}>{value}</span>
    </div>
  );
}

export function UsagePanel({ usage }: { usage: TokenUsage }) {
  const { t, lang } = useT();
  const [open, setOpen] = useState(false);
  const num = (n: number) => n.toLocaleString(locale(lang));
  const agents = Object.entries(usage.by_agent).sort((a, b) => b[1].cost_usd - a[1].cost_usd);
  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: ".6px", marginBottom: 8 }}>{t("research.usage.title")}</div>
      <div title={t("research.usage.tip")} style={{ padding: "8px 10px", borderRadius: 7, background: "var(--surface2)", border: "1px solid var(--border)" }}>
        <Row label={t("research.usage.input")} value={num(usage.total_input)} />
        <Row label={t("research.usage.output")} value={num(usage.total_output)} />
        <Row label={t("research.usage.cost")} value={usd(usage.cost_usd)} />
        {agents.length > 0 && (
          <button onClick={() => setOpen((v) => !v)} aria-expanded={open}
                  style={{ display: "flex", alignItems: "center", gap: 4, width: "100%", marginTop: 4, padding: "4px 0 0", border: "none", borderTop: "1px solid var(--border)", background: "transparent", color: "var(--accent)", fontSize: 11, cursor: "pointer" }}>
            {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}{t("research.usage.byAgent")}
          </button>
        )}
        {open && agents.map(([name, u]) => (
          <div key={name} style={{ marginTop: 6, fontSize: 11, color: "var(--text2)", lineHeight: 1.5 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 600 }}>
              <span>{name}</span><span>{usd(u.cost_usd)}</span>
            </div>
            <div style={{ color: "var(--text3)" }}>{num(u.input)} / {num(u.output)}</div>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 10, color: "var(--text4)", marginTop: 4, lineHeight: 1.4 }}>{t("research.usage.tip")}</div>
    </div>
  );
}
