/**
 * The part of Reflex that works while nobody is looking.
 *
 * One Fountain stream per person with an assistant. Every reply is folded as
 * it streams; when a turn ends, the ```reflex block is parsed and jobs,
 * memory and notifications land in the database, whether or not a tab is
 * open. Pages that are open get the same events over /api/stream.
 */
import type { Fountain } from "@agentshit/fountain-sdk";
import type { AssistantView, NotificationView, StreamEvent } from "../shared/api";
import { parseUpdate } from "../shared/protocol";
import { absorb, busy, fold, presence, roster, type LogEvent } from "./fountain";
import * as store from "./store";
import type { Sql } from "./store";

type Listener = (e: StreamEvent) => void;

export class Hub {
  private listeners = new Map<number, Set<Listener>>();

  subscribe(userId: number, fn: Listener): () => void {
    let set = this.listeners.get(userId);
    if (!set) {
      set = new Set();
      this.listeners.set(userId, set);
    }
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (set!.size === 0) this.listeners.delete(userId);
    };
  }

  emit(userId: number, e: StreamEvent): void {
    for (const fn of this.listeners.get(userId) ?? []) {
      try {
        fn(e);
      } catch {
        // a closed page
      }
    }
  }
}

export interface WatcherDeps {
  sql: Sql;
  hub: Hub;
  /** a fresh SDK client for this person, with their own key */
  clientFor: (userId: number) => Promise<Fountain | null>;
  /** send one queued message, if the assistant is free; used to drain the outbox */
  sendQueued: (userId: number) => Promise<void>;
}

interface Running {
  stop: () => void;
}

export class Watchers {
  private running = new Map<number, Running>();

  constructor(private deps: WatcherDeps) {}

  /** Start (or restart) the watcher for one person. Idempotent. */
  start(userId: number): void {
    this.stop(userId);
    const ctrl = new AbortController();
    this.running.set(userId, { stop: () => ctrl.abort() });
    void this.loop(userId, ctrl.signal);
  }

  stop(userId: number): void {
    this.running.get(userId)?.stop();
    this.running.delete(userId);
  }

  async startAll(): Promise<void> {
    for (const u of await store.usersWithAssistant(this.deps.sql)) this.start(u.id);
  }

  private async loop(userId: number, signal: AbortSignal): Promise<void> {
    const { sql } = this.deps;
    let backoff = 1000;
    while (!signal.aborted) {
      const user = await store.userById(sql, userId);
      if (!user?.agentId) return;
      const f = await this.deps.clientFor(userId);
      if (!f) return;
      const turns = new Map<string, { text: string; steps: string[] }>();
      try {
        // On (re)connect: presence, then anything that ended while we were away.
        await this.settle(f, user.agentId, userId);
        const after = await store.cursor(sql, userId);
        for await (const ev of f.team.stream({ streams: ["stdout", "acp", "stage"], after: after || undefined, signal, maxRetries: 0 })) {
          backoff = 1000;
          if (typeof ev.id === "number") void store.saveCursor(sql, userId, ev.id);
          if (!ev.agent_id) {
            // a team/schedule notice: re-read presence
            await this.settle(f, user.agentId, userId).catch(() => undefined);
            continue;
          }
          if (ev.agent_id !== user.agentId) continue;
          if (ev.conversation_id && ev.conversation_id !== user.conversationId) {
            user.conversationId = ev.conversation_id;
            await store.updateUser(sql, userId, { conversationId: ev.conversation_id });
          }
          await this.handle(f, user.agentId, userId, ev, turns);
        }
      } catch (err) {
        if (signal.aborted) return;
        console.warn(`watcher ${userId}: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (signal.aborted) return;
      await Bun.sleep(backoff);
      backoff = Math.min(backoff * 2, 30_000);
    }
  }

  private async settle(f: Fountain, agentId: string, userId: number): Promise<void> {
    const t = await roster(f, agentId);
    this.deps.hub.emit(userId, { type: "assistant", assistant: presence(t) });
    if (t && t.presence.state !== "working" && t.presence.state !== "starting") await this.deps.sendQueued(userId);
  }

  private async handle(f: Fountain, agentId: string, userId: number, ev: LogEvent & { conversation_id?: string }, turns: Map<string, { text: string; steps: string[] }>): Promise<void> {
    const { hub } = this.deps;
    const turnId = ev.turn_id ?? null;
    if (ev.kind === "output" && turnId) {
      let acc = turns.get(turnId);
      if (!acc) {
        acc = { text: "", steps: [] };
        turns.set(turnId, acc);
      }
      const delta = absorb(acc, ev);
      if (delta.text) hub.emit(userId, { type: "text", turnId, text: stripLive(delta.text) });
      if (delta.step) hub.emit(userId, { type: "step", turnId, text: delta.step });
      return;
    }
    if (ev.kind === "stage" && ev.stage === "turn") {
      if (ev.state === "started") {
        hub.emit(userId, { type: "turn", state: "started", turnId });
        hub.emit(userId, { type: "assistant", assistant: workingView() });
        return;
      }
      if (ev.state === "done" || ev.state === "failed" || ev.state === "interrupted") {
        let text = turnId ? turns.get(turnId)?.text : undefined;
        if (text === undefined && ev.conversation_id) {
          // Reconnected mid-turn: read the turn back in full.
          try {
            const folded = await fold(f, ev.conversation_id);
            text = folded.find((t) => t.id === turnId)?.text ?? folded[folded.length - 1]?.text ?? "";
          } catch {
            text = "";
          }
        }
        if (turnId) turns.delete(turnId);
        if (text) await this.apply(userId, text);
        hub.emit(userId, { type: "turn", state: ev.state, turnId });
        await this.settle(f, agentId, userId).catch(() => undefined);
      }
      return;
    }
    if (ev.kind === "stage" && (ev.stage === "provision" || ev.stage === "setup" || ev.stage === "terminate" || ev.stage === "sandbox")) {
      await this.settle(f, agentId, userId).catch(() => undefined);
    }
  }

  /** The block → the database → the page. */
  async apply(userId: number, text: string): Promise<void> {
    const { sql, hub } = this.deps;
    const u = parseUpdate(text);
    for (const j of u.jobs) await store.upsertJob(sql, userId, j);
    for (const [k, v] of Object.entries(u.memory)) await store.setMemory(sql, userId, k, v);
    if (u.jobs.length) hub.emit(userId, { type: "jobs" });
    for (const n of u.notify) {
      const row = await store.addNotification(sql, userId, n.kind, n.text);
      const view: NotificationView = { id: row.id, kind: row.kind, text: row.text, at: row.createdAt.toISOString(), read: false };
      hub.emit(userId, { type: "notify", notification: view });
    }
  }
}

function workingView(): AssistantView {
  return { state: "working", label: "Reflex is working", hired: true };
}

/**
 * Text as it streams may contain the opening of the block before its close;
 * the page strips complete blocks, but a half-open fence would show. Cut at
 * the first "```reflex" so the owner never sees JSON typing itself out.
 */
export function stripLive(chunk: string): string {
  const i = chunk.indexOf("```reflex");
  return i === -1 ? chunk : chunk.slice(0, i);
}

export { busy };
