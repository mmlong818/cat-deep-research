// ── Research ──────────────────────────────────────────────────────────────

export interface SessionMeta {
  session_id: string;          // 没建成工作空间的失败任务为空串，此时用 task_id 标识
  task_id?: string | null;
  question: string;
  created_at: string;
  status?: string;             // running / completed / failed / stopped / interrupted / unknown
  final_score?: number | null;
  total_cycles?: number | null;
  depth?: string | null;
  language?: string | null;
  provider?: string | null;    // 多模型之前的会话为空
  core_model?: string | null;
  support_model?: string | null;
  current_phase?: string | null;
  phase_key?: string | null;
  error?: string | null;
}

export interface PhaseRecord {
  phase_num: number;
  phase: string;
  phase_key: string | null;
  status: string;
  started_at: string;
  finished_at: string | null;
  error: string | null;
}

export interface PhaseLogTask {
  task_id: string;
  status: string;
  error: string | null;
  created_at: string;
  replay_from: string | null;
  phases: PhaseRecord[];
}

export type StepStatus = "pending" | "active" | "done" | "error";

export interface PipelineStep {
  key: string;
  label: string;
  emoji: string;
  status: StepStatus;
  duration?: number;
}

export interface LogLine {
  type: "info" | "ok" | "warn" | "err" | "dim";
  text: string;
}

export interface ConfidenceBreakdownItem {
  weight?: string;
  score?: number;
  [k: string]: unknown;
}

export interface ConfidenceReport {
  overall_confidence?: number;
  confidence_level?: "high" | "medium" | "low";
  breakdown?: {
    source_quality?: ConfidenceBreakdownItem;
    fact_accuracy?: ConfidenceBreakdownItem;
    conclusion_validity?: ConfidenceBreakdownItem;
  };
  disputed_claims?: { claim: string; confidence: string }[];
}

export interface LedgerClaim {
  id: string;
  text: string;
  status: "unchecked" | "supported" | "disputed" | "unverifiable" | "overruled" | "merged";
  sources: { id: string; url: string; title: string }[];
}

export interface LedgerContradiction {
  id: string;
  topic: string;
  claims: LedgerClaim[];
  resolution: { sides_with: string; reason: string; evidence_url: string } | null;
}

export interface LedgerView {
  counts: { claims: number; citable: number; sources: number; contradictions: number; unresolved: number };
  contradictions: LedgerContradiction[];
  claims: LedgerClaim[];
}

export interface AgentUsage { input: number; output: number; cost_usd: number }

export interface TokenUsage {
  total_input: number;
  total_output: number;
  cost_usd: number;
  by_agent: Record<string, AgentUsage>;
}

export interface AuditEntry {
  task_id: string;
  session_id: string | null;
  kind: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface ResearchSource {
  title: string;
  url: string;
  authority_tier?: number;
  domain_score?: number;
}
