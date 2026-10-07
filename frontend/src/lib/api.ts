import type {
  SessionMeta, LedgerView, AuditEntry, TokenUsage, ReviewRound,
} from "./types";

const BASE = "/api";

// 后端在入口页注入的本地 API 令牌（见 api/security.py）；开发模式关闭校验时为空
const TOKEN =
  document.querySelector<HTMLMetaElement>('meta[name="cat-api-token"]')?.content ?? "";

/** EventSource 与下载链接无法加请求头，令牌放在查询参数里（后端仅对 GET 接受） */
export const withToken = (url: string) =>
  TOKEN ? `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(TOKEN)}` : url;

/** 接口错误：带 HTTP 状态码（429 = 已达并发上限，409 = 状态冲突），界面据此给出不同说明 */
export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function send(url: string, options?: RequestInit): Promise<Response> {
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
    throw new ApiError(typeof err.detail === "string" ? err.detail : res.statusText, res.status);
  }
  return res;
}

const req = <T,>(url: string, options?: RequestInit): Promise<T> => send(url, options).then((r) => r.json());

/** 带令牌取文本（草稿在线查看）。 */
export const fetchText = (url: string): Promise<string> => send(url).then((r) => r.text());

/** 按可读的文件名另存（后端下载接口的 Content-Disposition 文件名会盖过 <a download>，所以先取回再存）。 */
export async function saveText(url: string, filename: string) {
  const blob = new Blob([await fetchText(url)], { type: "text/markdown;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 0);
}

// ── Research ──────────────────────────────────────────────────────────────

export interface ResearchStartOptions {
  clarification?: string;
  research_strategy?: string;
  min_cycles?: number;
  max_cycles?: number;
  depth?: Depth;
  language?: "zh" | "en";
  /** 改进循环中即时询问是否继续（委托台默认开；不传则后端按关闭处理） */
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

  /** 停止：保留已有稿件与检查点，之后可从断点续办 */
  stop: (taskId: string) =>
    req(`${BASE}/research/${taskId}/stop`, { method: "POST" }),

  /** 删除没建成工作空间的任务记录（档案柜里只有任务编号的失败条目） */
  deleteTask: (taskId: string) =>
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

  report: (sessionId: string) =>
    req<{ report: string; confidence_report: Record<string, unknown>; token_usage: TokenUsage | null }>(
      `${BASE}/sessions/${sessionId}/report`
    ),

  phases: (sessionId: string) =>
    req<Record<string, unknown>>(`${BASE}/sessions/${sessionId}/phases`),

  deleteSession: (sessionId: string) =>
    req(`${BASE}/sessions/${sessionId}`, { method: "DELETE" }),

  ledger: (sessionId: string) => req<LedgerView>(`${BASE}/sessions/${sessionId}/ledger`),

  reviews: (sessionId: string) =>
    req<{ reviews: ReviewRound[] }>(`${BASE}/sessions/${sessionId}/reviews`).then((r) => r.reviews ?? []),

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

  health: () => req<{ status: string }>(`${BASE}/health`),
};

// ── Clarify（委托台：签发前和研究助理对话） ───────────────────────────────

/** 澄清智能体整理出的委托摘要（agents/clarifier.py 的 CLARIFY_SCHEMA） */
export interface ClarifySummary {
  objective: string;
  scope: string;
  key_aspects: string[];
  timeframe: string;
  depth: string;
  angle: string;
  exclude: string;
  search_hints: string[];
  intent_type: string;
  dimensions: { urgency: number; specificity: number; complexity: number };
}

export interface ClarifyTurn {
  message: string;
  summary: ClarifySummary;
  ready: boolean;
  confidence: number;
}

type ModelFields = Pick<ResearchStartOptions, "provider" | "core_model" | "support_model">;

export interface ClarifyConfirmOptions extends ModelFields {
  summary: ClarifySummary;
  /** 委托台上的研究问题（改过的以此为准；空白时后端沿用澄清时的原问题） */
  question?: string;
  /** 研究目标，后端写进补充说明第一行 */
  goal?: string;
  /** 特别要求 */
  extra_note?: string;
  min_cycles?: number;
  max_cycles?: number;
  depth?: Depth;
  language?: "zh" | "en";
  ask_loop?: boolean;
}

export const clarify = {
  start: (question: string, model: ModelFields) =>
    req<ClarifyTurn & { clarify_id: string }>(`${BASE}/clarify`, {
      method: "POST",
      body: JSON.stringify({ question, ...model }),
    }),
  reply: (clarifyId: string, message: string) =>
    req<ClarifyTurn & { turns: number }>(`${BASE}/clarify/${clarifyId}/message`, {
      method: "POST",
      body: JSON.stringify({ message }),
    }),
  confirm: (clarifyId: string, opts: ClarifyConfirmOptions) =>
    req<{ task_id: string }>(`${BASE}/clarify/${clarifyId}/confirm`, {
      method: "POST",
      body: JSON.stringify(opts),
    }),
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
