import type {
  SessionMeta, LedgerView, AuditEntry, TokenUsage, PhaseLogTask,
} from "./types";

const BASE = "/api";

// 后端在入口页注入的本地 API 令牌（见 api/security.py）；开发模式关闭校验时为空
const TOKEN =
  document.querySelector<HTMLMetaElement>('meta[name="cat-api-token"]')?.content ?? "";

/** EventSource 与下载链接无法加请求头，令牌放在查询参数里（后端仅对 GET 接受） */
export const withToken = (url: string) =>
  TOKEN ? `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(TOKEN)}` : url;

async function req<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(TOKEN ? { "X-Cat-Token": TOKEN } : {}),
      ...(options?.headers as Record<string, string> | undefined),
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? res.statusText);
  }
  return res.json();
}

// ── Research ──────────────────────────────────────────────────────────────

export interface ResearchStartOptions {
  clarification?: string;
  research_strategy?: string;
  min_cycles?: number;
  max_cycles?: number;
  depth?: Depth;
  language?: "zh" | "en";
  /** 改进循环中即时询问是否继续（研究页默认开；不传则后端按关闭处理） */
  ask_loop?: boolean;
  /** 本次临时指定提供方/模型；都不传则用设置里的默认配置档 */
  provider?: Provider;
  core_model?: string;
  support_model?: string;
}

export type Depth = "quick" | "standard" | "deep";

export interface DraftFile {
  kind: "draft" | "final";
  draft_num: number | null;
  name: string;
  size: number;
  modified_at: string;
  download_url: string;
}

export const research = {
  start: (question: string, opts: ResearchStartOptions = {}) =>
    req<{ task_id: string }>(`${BASE}/research`, {
      method: "POST",
      body: JSON.stringify({ question, ...opts }),
    }),

  drafts: (sessionId: string) =>
    req<{ session_id: string; drafts: DraftFile[] }>(
      `${BASE}/sessions/${sessionId}/drafts`
    ).then((r) => r.drafts ?? []),

  stream: (taskId: string) => new EventSource(withToken(`${BASE}/research/${taskId}/stream`)),

  status: (taskId: string) => req<Record<string, unknown>>(`${BASE}/research/${taskId}/status`),

  stop: (taskId: string) =>
    req(`${BASE}/research/${taskId}`, { method: "DELETE" }),

  pause: (taskId: string) =>
    req(`${BASE}/research/${taskId}/pause`, { method: "POST" }),

  resume: (taskId: string) =>
    req(`${BASE}/research/${taskId}/resume`, { method: "POST" }),

  loopDecision: (taskId: string, choice: "continue" | "stop") =>
    req(`${BASE}/research/${taskId}/loop-decision`, {
      method: "POST",
      body: JSON.stringify({ choice }),
    }),

  inject: (taskId: string, message: string) =>
    req(`${BASE}/research/${taskId}/message`, {
      method: "POST",
      body: JSON.stringify({ message }),
    }),

  sessions: (offset = 0, limit = 50) =>
    req<{ sessions: SessionMeta[]; total?: number } | SessionMeta[]>(`${BASE}/sessions?offset=${offset}&limit=${limit}`)
      .then((r) => {
        const list = Array.isArray(r) ? r : r.sessions ?? [];
        return { sessions: list, total: Array.isArray(r) ? list.length : r.total ?? list.length };
      }),

  stopAll: () => req(`${BASE}/research/stop-all`, { method: "POST" }),

  report: (sessionId: string) =>
    req<{ report: string; confidence_report: Record<string, unknown>; token_usage: TokenUsage | null }>(
      `${BASE}/sessions/${sessionId}/report`
    ),

  phases: (sessionId: string) =>
    req<Record<string, unknown>>(`${BASE}/sessions/${sessionId}/phases`),

  deleteSession: (sessionId: string) =>
    req(`${BASE}/sessions/${sessionId}`, { method: "DELETE" }),

  ledger: (sessionId: string) => req<LedgerView>(`${BASE}/sessions/${sessionId}/ledger`),

  checkpoints: (sessionId: string) =>
    req<{ phases: string[]; checkpoints: { phase: string; created_at: string }[]; resume_from: string | null }>(
      `${BASE}/sessions/${sessionId}/checkpoints`),

  replay: (sessionId: string, fromPhase: string | null) =>
    req<{ task_id: string; from_phase: string }>(`${BASE}/sessions/${sessionId}/replay`, {
      method: "POST",
      body: JSON.stringify({ from_phase: fromPhase }),
    }),

  audit: (sessionId: string) =>
    req<{ entries: AuditEntry[] }>(`${BASE}/sessions/${sessionId}/audit`),

  phaseLog: (sessionOrTaskId: string) =>
    req<{ tasks: PhaseLogTask[] }>(`${BASE}/sessions/${sessionOrTaskId}/phase-log`),

  health: () => req<{ status: string }>(`${BASE}/health`),
};

// ── Config ────────────────────────────────────────────────────────────────

export const PROVIDERS = ["claude", "openai", "zhipu"] as const;
export type Provider = (typeof PROVIDERS)[number];

export interface ModelInfo {
  id: string;
  tier: "low" | "mid" | "high";   // 按输出价粗分的价格档
  input_price: number;            // 美元 / 百万 token
  output_price: number;
}

export interface ProviderInfo {
  needs_key: boolean;             // Claude 走订阅，Anthropic key 只是可选
  has_key: boolean;
  key_source: "" | "keyring" | "env";
  key_preview: string;            // 形如 "...abcd"，只含末 4 位
  available: boolean;             // 可用于启动任务：不需要 key，或 key 已配置
  defaults: { core: string; support: string };
  models: ModelInfo[];
}

export interface ProfileChoice { provider: Provider; core: string; support: string }

export interface SettingsInfo {
  default_profile: ProfileChoice;
  providers: Record<Provider, ProviderInfo>;
}

export const config = {
  get: () => req<SettingsInfo>(`${BASE}/settings`),
  /** api_keys 里空字符串表示不改；删除 key 用 clearKey */
  update: (body: { default_profile?: ProfileChoice; api_keys?: Partial<Record<Provider, string>> }) =>
    req<SettingsInfo>(`${BASE}/settings`, { method: "POST", body: JSON.stringify(body) }),
  clearKey: (provider: Provider) => req<SettingsInfo>(`${BASE}/settings/keys/${provider}`, { method: "DELETE" }),
};
