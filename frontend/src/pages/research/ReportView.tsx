import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { research } from "../../lib/api";
import type { LedgerClaim, LedgerContradiction, LedgerView } from "../../lib/types";
import { linkCitations } from "./citations";
import { useT, type TKey } from "../../i18n";

/** 报告来自网页抓取 + 模型生成，属不可信内容：转 HTML 后必须清理掉脚本、事件属性等再插入页面。 */
const renderReport = (md: string) => DOMPurify.sanitize(marked.parse(linkCitations(md)) as string);

export function ReportBody({ markdown }: { markdown: string }) {
  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    const href = a?.getAttribute("href") ?? "";
    if (!href.startsWith("#cite-")) return;
    e.preventDefault();
    const target = document.getElementById(href.slice(1))?.parentElement;
    target?.scrollIntoView({ behavior: "smooth", block: "center" });
    target?.animate([{ background: "var(--accent-dim)" }, { background: "transparent" }], { duration: 1600 });
  };
  return (
    <div
      className="report-body"
      style={{ padding: 20 }}
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: renderReport(markdown) }}
    />
  );
}

/** 声明在这一处矛盾里的裁决结果（同一声明可能卷入多处矛盾，不能用它的全局状态）。 */
function verdict(x: LedgerContradiction, cid: string): { label: TKey; color: string } {
  if (!x.resolution) return { label: "research.verdict.none", color: "var(--text3)" };
  if (x.resolution.sides_with === "neither") return { label: "research.verdict.neither", color: "var(--warning)" };
  return x.resolution.sides_with === cid
    ? { label: "research.verdict.won", color: "var(--success)" }
    : { label: "research.verdict.overturned", color: "var(--danger)" };
}

function ClaimRow({ claim, st }: { claim: LedgerClaim; st: { label: TKey; color: string } }) {
  const { t } = useT();
  return (
    <div style={{ padding: "6px 10px", borderLeft: `3px solid ${st.color}`, marginBottom: 4, fontSize: 12, color: "var(--text2)", lineHeight: 1.6 }}>
      <span style={{ fontSize: 10, fontWeight: 700, color: st.color, marginRight: 6 }}>{claim.id} · {t(st.label)}</span>
      {claim.text}
      {claim.sources.map((s) => (
        <a key={s.id} href={s.url} target="_blank" rel="noopener noreferrer" title={s.url}
           style={{ marginLeft: 6, fontSize: 11, color: "var(--accent)" }}>{s.title || s.id}</a>
      ))}
    </div>
  );
}

function ContradictionsPanel({ view }: { view: LedgerView }) {
  const { t } = useT();
  if (view.contradictions.length === 0) return null;
  return (
    <div style={{ borderTop: "1px solid var(--border)", padding: "12px 20px" }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text3)", letterSpacing: ".5px", marginBottom: 8 }}>
        {t("research.contra.title", { n: view.contradictions.length, u: view.counts.unresolved, c: view.counts.citable, s: view.counts.sources })}
      </div>
      {view.contradictions.map((x) => (
        <div key={x.id} style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>{x.id} {x.topic}</div>
          {x.claims.map((c) => <ClaimRow key={c.id} claim={c} st={verdict(x, c.id)} />)}
          <div style={{ fontSize: 11, color: "var(--text3)", paddingLeft: 13 }}>
            {x.resolution ? (
              <>{t("research.contra.reason", { r: x.resolution.reason })}
                {x.resolution.evidence_url && (
                  <a href={x.resolution.evidence_url} target="_blank" rel="noopener noreferrer"
                     style={{ marginLeft: 6, color: "var(--accent)" }}>{t("research.contra.evidence")}</a>
                )}
              </>
            ) : t("research.contra.pending")}
          </div>
        </div>
      ))}
    </div>
  );
}

const CLAIM_STATUS: { key: Exclude<LedgerClaim["status"], "merged">; label: TKey; color: string }[] = [
  { key: "supported", label: "research.status.supported", color: "var(--success)" },
  { key: "disputed", label: "research.status.disputed", color: "var(--warning)" },
  { key: "unverifiable", label: "research.status.unverifiable", color: "var(--text3)" },
  { key: "overruled", label: "research.status.overruled", color: "var(--danger)" },
  { key: "unchecked", label: "research.status.unchecked", color: "var(--text4)" },
];

function ClaimsPanel({ claims }: { claims: LedgerClaim[] }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<string>("all");
  if (claims.length === 0) return null;
  const shown = filter === "all" ? claims : claims.filter((c) => c.status === filter);
  const chip = (key: string, label: string, n: number) => (
    <button key={key} onClick={() => setFilter(key)} aria-pressed={filter === key}
            style={{ padding: "3px 9px", borderRadius: 12, fontSize: 11, cursor: "pointer", border: "1px solid var(--border)",
                     background: filter === key ? "var(--accent-dim)" : "transparent",
                     color: filter === key ? "var(--accent)" : "var(--text3)", fontWeight: filter === key ? 700 : 400 }}>
      {label} {n}
    </button>
  );
  return (
    <div style={{ borderTop: "1px solid var(--border)", padding: "12px 20px" }}>
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open}
              style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", padding: 0, border: "none", background: "transparent", cursor: "pointer",
                       fontSize: 11, fontWeight: 700, color: "var(--text3)", letterSpacing: ".5px", textAlign: "left" }}>
        {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        {t("research.claims.title", { n: claims.length })}
      </button>
      {open && (
        <div style={{ marginTop: 8 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
            {chip("all", t("research.claims.all"), claims.length)}
            {CLAIM_STATUS.map((s) => ({ s, n: claims.filter((c) => c.status === s.key).length }))
              .filter(({ n }) => n > 0)
              .map(({ s, n }) => chip(s.key, t(s.label), n))}
          </div>
          {shown.length === 0 && <div style={{ fontSize: 12, color: "var(--text4)" }}>{t("research.claims.empty")}</div>}
          {shown.map((c) => <ClaimRow key={c.id} claim={c} st={CLAIM_STATUS.find((s) => s.key === c.status) ?? CLAIM_STATUS[4]} />)}
        </div>
      )}
    </div>
  );
}

export function LedgerPanels({ sessionId }: { sessionId: string | null }) {
  const [view, setView] = useState<LedgerView | null>(null);
  useEffect(() => {
    setView(null);
    if (sessionId) research.ledger(sessionId).then(setView).catch(() => setView(null));
  }, [sessionId]);
  if (!view) return null;
  return (
    <>
      <ContradictionsPanel view={view} />
      <ClaimsPanel claims={view.claims} />
    </>
  );
}
