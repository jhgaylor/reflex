/**
 * The Reflex API: intent-shaped, in the owner's words. Every handler resolves
 * the session to a person, builds a Fountain client with that person's own
 * key, and translates both ways.
 */
import { Fountain } from "@agentshit/fountain-sdk";
import type { ConnectionsView, JobView, Me, MemoryView, NotificationView, PlanView, StreamEvent, ThreadView } from "../shared/api";
import type { JobStatus } from "../shared/protocol";
import { DEFAULT_GUARDRAILS, relayedPrompt, type Guardrails, type Profile } from "../shared/spec";
import { busy, client, ensureVault, fold, grantContact, hire, presence, ReflexError, revokeContact, roster, toRoutineView, toTurnView, translate, type Contact } from "./fountain";
import { clearedCookie, newSessionToken, secureFor, sessionCookie, sessionToken } from "./session";
import * as store from "./store";
import type { Sql, User } from "./store";
import { stripLive, type Hub, type Watchers } from "./watcher";

export interface ApiDeps {
  sql: Sql;
  secret: string;
  hub: Hub;
  watchers: Watchers;
}

type Handler = (req: Request, url: URL) => Promise<Response>;

const json = (data: unknown, status = 200, headers?: Record<string, string>) => Response.json(data, { status, headers });
const fail = (e: ReflexError) => json({ error: e.code, message: e.message }, e.status);

export function buildApi(deps: ApiDeps): Handler {
  const { sql, secret, hub, watchers } = deps;

  const clientFor = async (u: User): Promise<Fountain> => {
    const key = await store.fountainKey(sql, secret, u.id);
    if (!key) throw new ReflexError(401, "signed_out", "Please sign in again.");
    return client(u.fountainUrl, key);
  };

  const me = async (u: User): Promise<Me> => {
    let assistant = presence(null);
    if (u.agentId) {
      try {
        assistant = presence(await roster(await clientFor(u), u.agentId));
      } catch {
        assistant = { state: "trouble", label: "Reflex could not be reached", hired: true };
      }
    }
    return { signedIn: true, email: u.email, setupStep: u.setupStep, profile: u.profile, assistant };
  };

  /** Send now, or queue if the assistant is mid-turn. */
  const send = async (u: User, f: Fountain, text: string): Promise<{ queued: boolean }> => {
    if (!u.agentId) throw new ReflexError(409, "not_ready", "Finish setup first.");
    try {
      await f.request("POST", `/api/team/${u.agentId}/messages`, { body: { prompt: text } });
      return { queued: false };
    } catch (err) {
      if (busy(err)) {
        await store.enqueue(sql, u.id, text);
        return { queued: true };
      }
      throw err;
    }
  };

  /** Called by the watcher whenever the assistant goes idle. */
  const sendQueued = async (userId: number): Promise<void> => {
    const u = await store.userById(sql, userId);
    if (!u?.agentId) return;
    const next = await store.nextQueued(sql, userId);
    if (!next) return;
    const f = await clientFor(u);
    try {
      await f.request("POST", `/api/team/${u.agentId}/messages`, { body: { prompt: next.text } });
      await store.dequeue(sql, next.id);
    } catch (err) {
      if (!busy(err)) console.warn(`outbox ${userId}: ${translate(err).message}`);
    }
  };
  deps.watchers["deps"].sendQueued = sendQueued;
  deps.watchers["deps"].clientFor = async (userId) => {
    const u = await store.userById(sql, userId);
    return u ? clientFor(u).catch(() => null) : null;
  };

  /** Make sure the person has an assistant; (re)apply the prompt. */
  const ensureAssistant = async (u: User, f: Fountain): Promise<User> => {
    const vaultId = u.vaultId ?? (await ensureVault(f, String(u.id)));
    const { agent, teammate } = await hire(f, String(u.id), u.profile, { vaultId });
    const changed = agent.id !== u.agentId || teammate.conversation.id !== u.conversationId || vaultId !== u.vaultId;
    const updated = changed ? await store.updateUser(sql, u.id, { agentId: agent.id, conversationId: teammate.conversation.id, vaultId }) : u;
    if (changed || !u.agentId) watchers.start(u.id);
    return updated;
  };

  const connections = async (u: User, f: Fountain): Promise<ConnectionsView> => {
    let texting: ConnectionsView["texting"] = { available: false, reason: null };
    let contact: ConnectionsView["contact"] = null;
    try {
      const s = await f.team.commsStatus();
      if (!s.enabled) texting = { available: false, reason: "Texting is not turned on for this account yet." };
      else if (!s.configured) texting = { available: false, reason: "Texting is not set up on this Reflex yet." };
      else texting = { available: true, reason: null };
    } catch {
      texting = { available: false, reason: "Could not check whether texting is available." };
    }
    if (u.agentId) {
      const t = await roster(f, u.agentId);
      const c = (t?.contact ?? null) as Contact | null;
      if (c) contact = { email: c.email, phone: c.phone, yourNumber: c.prompt_from_number ?? null, optedOut: Boolean(c.prompt_opted_out_at) };
    }
    const accounts = (await store.listAccounts(sql, u.id)).map((a) => ({ key: a.key, label: a.label, addedAt: a.addedAt.toISOString() }));
    return { texting, contact, accounts };
  };

  return async (req, url) => {
    const path = url.pathname;
    const secure = secureFor(req, url);

    // ── session ───────────────────────────────────────────────────────────
    if (path === "/api/session" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { apiKey?: string; baseUrl?: string };
      const apiKey = body.apiKey?.trim();
      const baseUrl = (body.baseUrl ?? "").trim().replace(/\/+$/, "");
      if (!apiKey || !/^https?:\/\//.test(baseUrl)) return fail(new ReflexError(422, "invalid", "Sign-in did not come back with what it needed."));
      let email: string;
      try {
        const who = await client(baseUrl, apiKey).me();
        email = who.email ?? `user-${who.id}`;
      } catch (err) {
        return fail(translate(err));
      }
      const user = await store.upsertUser(sql, secret, { email, fountainUrl: baseUrl, apiKey });
      const token = newSessionToken();
      await store.createSession(sql, user.id, token);
      if (user.agentId) watchers.start(user.id);
      return json(await me(user), 200, { "set-cookie": sessionCookie(token, { secure }) });
    }

    // Local development only (REFLEX_DEV=1): adopt a session token minted by
    // curl, so a browser can be signed in without the OAuth client existing.
    if (path === "/api/dev/session" && req.method === "POST" && process.env.REFLEX_DEV === "1") {
      const b = (await req.json().catch(() => ({}))) as { token?: string };
      if (!b.token || !(await store.userForSession(sql, b.token))) return fail(new ReflexError(401, "signed_out", "No such session."));
      return new Response(null, { status: 204, headers: { "set-cookie": sessionCookie(b.token, { secure }) } });
    }

    const token = sessionToken(req);
    const user = token ? await store.userForSession(sql, token) : null;

    if (path === "/api/me" && req.method === "GET") {
      if (!user) return json({ signedIn: false } satisfies Me);
      return json(await me(user));
    }
    if (path === "/api/signout" && req.method === "POST") {
      if (token) await store.deleteSession(sql, token);
      return new Response(null, { status: 204, headers: { "set-cookie": clearedCookie({ secure }) } });
    }
    if (!user) return fail(new ReflexError(401, "signed_out", "Please sign in."));

    try {
      // ── profile / setup ───────────────────────────────────────────────
      if (path === "/api/profile" && req.method === "GET") return json(user.profile);
      if (path === "/api/profile" && req.method === "PUT") {
        const b = (await req.json()) as Partial<Profile>;
        const profile: Profile = {
          name: String(b.name ?? "").slice(0, 80),
          timezone: String(b.timezone ?? "UTC").slice(0, 64),
          about: String(b.about ?? "").slice(0, 4000),
          guardrails: { ...DEFAULT_GUARDRAILS, ...((b.guardrails ?? {}) as Partial<Guardrails>) },
        };
        let u = await store.updateUser(sql, user.id, { profile, ...(user.setupStep === "profile" ? { setupStep: "reach" as const } : {}) });
        if (u.agentId) u = await ensureAssistant(u, await clientFor(u));
        return json(await me(u));
      }
      if (path === "/api/setup/done" && req.method === "POST") {
        const f = await clientFor(user);
        let u = await ensureAssistant(user, f);
        u = await store.updateUser(sql, u.id, { setupStep: "done" });
        return json(await me(u));
      }

      // ── the thread ────────────────────────────────────────────────────
      if (path === "/api/thread" && req.method === "GET") {
        const f = await clientFor(user);
        const t = user.agentId ? await roster(f, user.agentId) : null;
        const convId = t?.conversation.id ?? user.conversationId;
        if (t && convId !== user.conversationId) await store.updateUser(sql, user.id, { conversationId: convId });
        const turns = convId ? (await fold(f, convId)).map(toTurnView) : [];
        let assistant = presence(t);
        if (stuck(turns)) assistant = { state: "trouble", label: "Reflex looks stuck. Press Stop to start a fresh thread.", hired: true };
        const view: ThreadView = { turns, assistant, queued: await store.queued(sql, user.id) };
        return json(view);
      }
      if (path === "/api/messages" && req.method === "POST") {
        const b = (await req.json()) as { text?: string };
        const text = (b.text ?? "").trim().slice(0, 8000);
        if (!text) return fail(new ReflexError(422, "invalid", "Say something first."));
        const f = await clientFor(user);
        const u = user.agentId ? user : await ensureAssistant(user, f);
        return json(await send(u, f, text), 202);
      }
      if (path === "/api/stop" && req.method === "POST") {
        if (!user.agentId) return json({ mode: "idle" });
        const f = await clientFor(user);
        // Interrupt first. If Fountain refuses (BinaryBourbon/fountain#1179: an
        // autonomous turn that never ends and 404s on interrupt) or the turn
        // is still running a few seconds later, retire the thread instead:
        // Reflex keeps its computer and notes, the owner gets an assistant
        // that answers.
        let stopped = false;
        try {
          const conv = await f.team.conversation(user.agentId);
          await conv.interrupt();
          await Bun.sleep(4000);
          stopped = (await conv.status()) !== "running";
        } catch (err) {
          console.warn(`stop ${user.id}: interrupt failed (${translate(err).code}); starting a fresh thread`);
        }
        if (stopped) return json({ mode: "stopped" });
        const fresh = await f.team.freshConversation(user.agentId);
        const id = (fresh as { id?: string }).id ?? (await roster(f, user.agentId))?.conversation.id ?? null;
        if (id) await store.updateUser(sql, user.id, { conversationId: id });
        watchers.start(user.id);
        hub.emit(user.id, { type: "turn", state: "interrupted", turnId: null });
        return json({ mode: "fresh" });
      }
      if (path === "/api/stream" && req.method === "GET") return stream(hub, user.id);

      // ── jobs ──────────────────────────────────────────────────────────
      if (path === "/api/jobs" && req.method === "GET") return json((await store.listJobs(sql, user.id)).map(jobView));
      const jobM = path.match(/^\/api\/jobs\/([^/]+)$/);
      if (jobM && req.method === "PATCH") {
        const b = (await req.json()) as { status?: JobStatus };
        if (b.status !== "dropped") return fail(new ReflexError(422, "invalid", "You can only drop a job from here; ask Reflex for anything else."));
        const key = decodeURIComponent(jobM[1]!);
        const row = await store.setJobStatus(sql, user.id, key, "dropped");
        if (!row) return fail(new ReflexError(404, "not_found", "That job is not there any more."));
        hub.emit(user.id, { type: "jobs" });
        if (user.agentId) {
          const f = await clientFor(user);
          await send(user, f, `Drop the job "${row.title}" (${row.key}). Stop working on it and do not bring it back unless I ask.`).catch(() => undefined);
        }
        return json(jobView(row));
      }

      // ── memory ────────────────────────────────────────────────────────
      if (path === "/api/memory" && req.method === "GET") return json((await store.listMemory(sql, user.id)).map(memView));
      const memM = path.match(/^\/api\/memory\/([^/]+)$/);
      if (memM && (req.method === "PUT" || req.method === "DELETE")) {
        const key = decodeURIComponent(memM[1]!).toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 60);
        const value = req.method === "DELETE" ? "" : String(((await req.json()) as { value?: string }).value ?? "").slice(0, 500);
        await store.setMemory(sql, user.id, key, value);
        if (user.agentId) {
          const f = await clientFor(user);
          const note = value ? `For your memory: ${key.replace(/_/g, " ")} is "${value}". Update your notes; no reply needed beyond one line.` : `Forget "${key.replace(/_/g, " ")}" entirely, including from your notes on your computer. One line back.`;
          await send(user, f, note).catch(() => undefined);
        }
        if (req.method === "DELETE") return new Response(null, { status: 204 });
        return json({ key, value, updatedAt: new Date().toISOString() } satisfies MemoryView);
      }

      // ── notifications ─────────────────────────────────────────────────
      if (path === "/api/notifications" && req.method === "GET") return json((await store.listNotifications(sql, user.id)).map(noteView));
      if (path === "/api/notifications/read" && req.method === "POST") {
        await store.markNotificationsRead(sql, user.id);
        return new Response(null, { status: 204 });
      }

      // ── routines ──────────────────────────────────────────────────────
      if (path.startsWith("/api/routines")) {
        const f = await clientFor(user);
        const u = user.agentId ? user : await ensureAssistant(user, f);
        const agentId = u.agentId!;
        if (path === "/api/routines" && req.method === "GET") return json((await f.team.schedules.list(agentId)).map(toRoutineView));
        if (path === "/api/routines" && req.method === "POST") {
          const b = (await req.json()) as { title?: string; cron?: string; prompt?: string };
          if (!b.title?.trim() || !b.cron?.trim() || !b.prompt?.trim()) return fail(new ReflexError(422, "invalid", "A routine needs a name, a time and something to do."));
          const s = await f.team.schedules.create(agentId, { name: b.title.trim().slice(0, 80), cron: b.cron.trim(), prompt: relayedPrompt("routine", b.prompt.trim().slice(0, 4000)), enabled: true });
          return json(toRoutineView(s), 201);
        }
        const rm = path.match(/^\/api\/routines\/([^/]+)(\/run)?$/);
        if (rm) {
          const id = decodeURIComponent(rm[1]!);
          if (rm[2] && req.method === "POST") {
            await f.team.schedules.run(agentId, id);
            return new Response(null, { status: 204 });
          }
          if (req.method === "PATCH") {
            const b = (await req.json()) as { cron?: string; enabled?: boolean; prompt?: string; title?: string };
            const s = await f.team.schedules.update(agentId, id, {
              ...(b.cron ? { cron: b.cron } : {}),
              ...(typeof b.enabled === "boolean" ? { enabled: b.enabled } : {}),
              ...(b.prompt ? { prompt: relayedPrompt("routine", b.prompt) } : {}),
              ...(b.title ? { name: b.title } : {}),
            });
            return json(toRoutineView(s));
          }
          if (req.method === "DELETE") {
            await f.team.schedules.delete(agentId, id);
            return new Response(null, { status: 204 });
          }
        }
      }

      // ── connections ───────────────────────────────────────────────────
      if (path.startsWith("/api/connections")) {
        const f = await clientFor(user);
        if (path === "/api/connections" && req.method === "GET") return json(await connections(user, f));
        if (path === "/api/connections/texting" && req.method === "POST") {
          const b = (await req.json()) as { yourNumber?: string };
          const n = (b.yourNumber ?? "").replace(/[^\d+]/g, "");
          if (n.replace(/\D/g, "").length < 10) return fail(new ReflexError(422, "invalid", "That does not look like a mobile number."));
          const u = await ensureAssistant(user, f);
          await grantContact(f, u.agentId!, n);
          return json(await connections(u, f));
        }
        if (path === "/api/connections/texting" && req.method === "DELETE") {
          if (user.agentId) await revokeContact(f, user.agentId);
          return json(await connections(user, f));
        }
        if (path === "/api/connections/accounts" && req.method === "POST") {
          const b = (await req.json()) as { key?: string; label?: string; value?: string };
          const key = (b.key ?? "").toUpperCase().replace(/[^A-Z0-9_]/g, "_").replace(/^_+|_+$/g, "").slice(0, 64);
          if (!key || !b.value) return fail(new ReflexError(422, "invalid", "An account needs a name and a value."));
          const u = await ensureAssistant(user, f);
          await f.vaults.secrets.set(u.vaultId!, key, b.value);
          await store.addAccount(sql, u.id, key, (b.label ?? key).slice(0, 80));
          return json(await connections(u, f));
        }
        const am = path.match(/^\/api\/connections\/accounts\/([^/]+)$/);
        if (am && req.method === "DELETE") {
          const key = decodeURIComponent(am[1]!);
          if (user.vaultId) await f.vaults.secrets.delete(user.vaultId, key).catch(() => undefined);
          await store.removeAccount(sql, user.id, key);
          return json(await connections(user, f));
        }
      }

      // ── plan ──────────────────────────────────────────────────────────
      if (path === "/api/plan" && req.method === "GET") {
        const f = await clientFor(user);
        try {
          const b = await f.request<{ data?: { credits?: { balance_cents?: number; turn_hour_cents?: number } | null } }>("GET", "/api/account/billing");
          const c = b.data?.credits ?? null;
          const view: PlanView = { balanceCents: c?.balance_cents ?? null, hourCents: c?.turn_hour_cents ?? null, addUrl: c ? `${user.fountainUrl}/account/billing` : null };
          return json(view);
        } catch {
          return json({ balanceCents: null, hourCents: null, addUrl: null } satisfies PlanView);
        }
      }

      return fail(new ReflexError(404, "not_found", "No such thing."));
    } catch (err) {
      const e = translate(err);
      if (e.status >= 500) console.error(`${req.method} ${path}:`, err);
      else if (e.status !== 401) console.warn(`${req.method} ${path}: ${e.status} ${e.code}`);
      return fail(e);
    }
  };
}

/** A turn "running" for 10+ minutes with nothing said is a wedged runtime, not work. */
const STUCK_MS = 10 * 60 * 1000;
function stuck(turns: import("../shared/api").TurnView[]): boolean {
  const last = turns[turns.length - 1];
  if (!last || last.status !== "running" || last.reply || last.steps.length > 0) return false;
  return Date.now() - Date.parse(last.at) > STUCK_MS;
}

function jobView(r: store.JobRow): JobView {
  return { key: r.key, title: r.title, status: r.status, note: r.note, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() };
}
function memView(m: { key: string; value: string; updatedAt: Date }): MemoryView {
  return { key: m.key, value: m.value, updatedAt: m.updatedAt.toISOString() };
}
function noteView(n: store.NotificationRow): NotificationView {
  return { id: n.id, kind: n.kind, text: n.text, at: n.createdAt.toISOString(), read: n.read };
}

/** Server-sent events for one person; heartbeat every 15 s. */
function stream(hub: Hub, userId: number): Response {
  const enc = new TextEncoder();
  let unsubscribe = () => {};
  let timer: ReturnType<typeof setInterval> | null = null;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const push = (e: StreamEvent) => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          // closed
        }
      };
      push({ type: "hello" });
      unsubscribe = hub.subscribe(userId, push);
      timer = setInterval(() => {
        try {
          controller.enqueue(enc.encode(": ping\n\n"));
        } catch {
          // closed
        }
      }, 15_000);
    },
    cancel() {
      unsubscribe();
      if (timer) clearInterval(timer);
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
}

export { stripLive };
