import { useCallback, useEffect, useRef } from "react";
import { research } from "../../lib/api";

// 任务进度 SSE：断线后指数退避重连（上限 30 秒）。每次（重）连接，服务端先发 snapshot 再回放缓冲事件，
// 调用方收到 snapshot 时清空界面状态，由回放重建，所以重连不会产生重复日志。

export interface StreamEvent {
  type: string;
  data: Record<string, any>;
}

const ACTIVE_TASK_KEY = "cr.activeTask";
const MAX_DELAY_MS = 30_000;
const FINAL_EVENTS = new Set(["completed", "error", "end"]);

export const loadActiveTask = (): string | null => {
  try { return localStorage.getItem(ACTIVE_TASK_KEY); } catch { return null; }
};
export const saveActiveTask = (id: string) => {
  try { localStorage.setItem(ACTIVE_TASK_KEY, id); } catch { /* ignore */ }
};
export const clearActiveTask = () => {
  try { localStorage.removeItem(ACTIVE_TASK_KEY); } catch { /* ignore */ }
};

export function useTaskStream(onEvent: (e: StreamEvent) => void) {
  const handlerRef = useRef(onEvent);
  const esRef = useRef<EventSource | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idRef = useRef<string | null>(null);
  const attemptRef = useRef(0);

  useEffect(() => { handlerRef.current = onEvent; });

  const disconnect = useCallback(() => {
    idRef.current = null;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    esRef.current?.close();
    esRef.current = null;
  }, []);

  const open = useCallback((id: string) => {
    const es = research.stream(id);
    esRef.current = es;

    es.onmessage = (e) => {
      let ev: StreamEvent;
      try { ev = JSON.parse(e.data); } catch { return; }
      if (ev.type === "snapshot") attemptRef.current = 0;
      if (FINAL_EVENTS.has(ev.type)) { idRef.current = null; es.close(); } // 任务已结束，不再重连
      handlerRef.current(ev);
    };

    // 浏览器自带重连没有退避且不通知我们：关掉，自己按退避重连
    es.onerror = () => {
      es.close();
      if (idRef.current !== id) return;
      const delay = Math.min(1000 * 2 ** attemptRef.current, MAX_DELAY_MS);
      attemptRef.current += 1;
      handlerRef.current({ type: "disconnected", data: { retry_in: Math.round(delay / 1000) } });
      timerRef.current = setTimeout(() => { if (idRef.current === id) open(id); }, delay);
    };
  }, []);

  const connect = useCallback((id: string) => {
    disconnect();
    idRef.current = id;
    attemptRef.current = 0;
    open(id);
  }, [disconnect, open]);

  useEffect(() => disconnect, [disconnect]);

  return { connect, disconnect };
}
