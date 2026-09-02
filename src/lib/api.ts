/**
 * The Reflex server, from the page. Same origin, cookie session, JSON in and
 * out. Errors carry the server's `error` code and a `message` already in the
 * owner's words, so the UI shows `err.message` and is done.
 */
import type {
  ConnectionsView,
  JobView,
  Me,
  MemoryPage,
  MessagePairingView,
  NotificationView,
  PlanView,
  ProfileView,
  RoutineView,
  StreamEvent,
  ThreadView,
} from "../../shared/api";
import type { Guardrails, RelayKind } from "../../shared/spec";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError(0, "offline", "Reflex could not be reached. Check your connection and try again.");
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    const o = (parsed ?? {}) as { error?: unknown; message?: unknown };
    const code = typeof o.error === "string" ? o.error : `http_${res.status}`;
    const message = typeof o.message === "string" ? o.message : res.status === 401 ? "Please sign in again." : "Something went wrong. Try again.";
    throw new ApiError(res.status, code, message);
  }
  return parsed as T;
}

export const api = {
  me: () => call<Me>("GET", "/api/me"),
  session: (apiKey: string, baseUrl: string) => call<Me>("POST", "/api/session", { apiKey, baseUrl }),
  signOut: () => call<void>("POST", "/api/signout"),

  saveProfile: (p: { name: string; timezone: string; about: string; guardrails: Guardrails }) => call<Me>("PUT", "/api/profile", p),
  finishSetup: () => call<Me>("POST", "/api/setup/done"),

  thread: () => call<ThreadView>("GET", "/api/thread"),
  send: (text: string) => call<{ queued: boolean }>("POST", "/api/messages", { text }),
  stop: () => call<{ mode: "stopped" | "fresh" | "idle" }>("POST", "/api/stop"),

  jobs: () => call<JobView[]>("GET", "/api/jobs"),
  dropJob: (key: string) => call<JobView>("PATCH", `/api/jobs/${encodeURIComponent(key)}`, { status: "dropped" }),

  memory: (q?: string) => call<MemoryPage>("GET", `/api/memory${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  remember: (content: string, category: string) => call<void>("POST", "/api/memory", { content, category }),
  forget: (id: string) => call<void>("DELETE", `/api/memory/${encodeURIComponent(id)}`),

  notifications: () => call<NotificationView[]>("GET", "/api/notifications"),
  markNotificationsRead: () => call<void>("POST", "/api/notifications/read"),

  routines: () => call<RoutineView[]>("GET", "/api/routines"),
  addRoutine: (r: { title: string; cron: string; prompt: string }) => call<RoutineView>("POST", "/api/routines", r),
  updateRoutine: (id: string, patch: { cron?: string; enabled?: boolean; prompt?: string; title?: string }) =>
    call<RoutineView>("PATCH", `/api/routines/${encodeURIComponent(id)}`, patch),
  removeRoutine: (id: string) => call<void>("DELETE", `/api/routines/${encodeURIComponent(id)}`),
  runRoutine: (id: string) => call<void>("POST", `/api/routines/${encodeURIComponent(id)}/run`),

  connections: () => call<ConnectionsView>("GET", "/api/connections"),
  enableTexting: (yourNumber: string) => call<ConnectionsView>("POST", "/api/connections/texting", { yourNumber }),
  disableTexting: () => call<ConnectionsView>("DELETE", "/api/connections/texting"),
  pairRelay: (kind: RelayKind) => call<MessagePairingView>("POST", `/api/connections/relays/${kind}/pair`),
  disconnectRelay: (id: string) => call<ConnectionsView>("DELETE", `/api/connections/relays/${encodeURIComponent(id)}`),
  disconnectService: (id: string) => call<ConnectionsView>("DELETE", `/api/connections/services/${encodeURIComponent(id)}`),
  addAccount: (a: { key: string; label: string; value: string }) => call<ConnectionsView>("POST", "/api/connections/accounts", a),
  removeAccount: (key: string) => call<ConnectionsView>("DELETE", `/api/connections/accounts/${encodeURIComponent(key)}`),

  plan: () => call<PlanView>("GET", "/api/plan"),
  profile: () => call<ProfileView>("GET", "/api/profile"),
};

/**
 * Live updates. Same origin and cookie-authenticated, so the browser's own
 * EventSource works and reconnects by itself. `onEvent` gets every parsed
 * event; `onState` says whether we are connected.
 */
export function openStream(onEvent: (e: StreamEvent) => void, onState: (live: boolean) => void): () => void {
  const es = new EventSource("/api/stream", { withCredentials: true });
  es.onopen = () => onState(true);
  es.onerror = () => onState(false);
  es.onmessage = (m) => {
    try {
      onEvent(JSON.parse(m.data) as StreamEvent);
    } catch {
      // a heartbeat or a malformed frame; ignore
    }
  };
  return () => es.close();
}
