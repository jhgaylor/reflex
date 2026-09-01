/**
 * Everything the server says to Fountain, in one place. The rest of the
 * server speaks Reflex (jobs, memory, routines, texting); this file speaks
 * agents, teammates, schedules, contacts and vaults, and translates back.
 */
import {
  AuthError,
  ConversationBusyError,
  Fountain,
  FountainError,
  NotFoundError,
  NotReadyError,
  QuotaExceededError,
  RateLimitError,
  SubscriptionRequiredError,
  ValidationError,
  type Agent,
  type Block,
  type Connection,
  type ConnectionProvider,
  type LogEvent,
  type Teammate,
} from "@agentshit/fountain-sdk";
import type { AssistantView, RoutineView, TurnView } from "../shared/api";
import { stripUpdate } from "../shared/protocol";
import { AGENT_RUNTIME, DEFAULT_MODEL, agentName, systemPrompt, type ConnectedAccount, type Profile } from "../shared/spec";

export type { Teammate, LogEvent, Block };

export function client(baseUrl: string, apiKey: string, timeoutMs = 30_000): Fountain {
  return new Fountain({ baseUrl, apiKey, timeoutMs });
}

/** Error → the owner's words plus a stable code the page can branch on. */
export class ReflexError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export function translate(err: unknown): ReflexError {
  if (err instanceof ReflexError) return err;
  if (err instanceof ConversationBusyError) return new ReflexError(409, "busy", "Reflex is in the middle of something.");
  if (err instanceof AuthError) return new ReflexError(401, "signed_out", "Your sign-in has expired. Sign in again.");
  if (err instanceof SubscriptionRequiredError) return new ReflexError(402, "out_of_funds", "Reflex is out of funds. Add more under Settings.");
  if (err instanceof QuotaExceededError) return new ReflexError(429, "too_many_computers", "Too many assistants are running on this account. Try again in a minute.");
  if (err instanceof NotReadyError) return new ReflexError(503, "waking", "Reflex's computer is still waking up. Try again in a moment.");
  if (err instanceof RateLimitError) return new ReflexError(429, "slow_down", "Too fast. Give it a second.");
  if (err instanceof NotFoundError) return new ReflexError(404, "not_found", "That is not there any more.");
  if (err instanceof ValidationError) return new ReflexError(422, "invalid", firstFieldError(err) ?? "Something in that was not accepted.");
  if (err instanceof FountainError) {
    if (err.code === "team_comms_not_enabled") return new ReflexError(404, "texting_unavailable", "Texting is not turned on for this account yet.");
    if (err.code === "team_comms_not_configured") return new ReflexError(503, "texting_unavailable", "Texting is not set up on this Reflex yet.");
    if (err.code === "provider_error") return new ReflexError(502, "texting_provider", "The phone company did not cooperate. Try again in a minute.");
    if (err.status === 0) return new ReflexError(502, "unreachable", "Reflex could not reach Fountain. Try again in a moment.");
    return new ReflexError(err.status || 500, err.code ?? "fountain", "Something went wrong on Reflex's side. Try again.");
  }
  return new ReflexError(500, "unknown", err instanceof Error ? err.message : "Something went wrong.");
}

function firstFieldError(err: ValidationError): string | null {
  const fe = err.fieldErrors;
  for (const [k, v] of Object.entries(fe)) if (v[0]) return `${k}: ${v[0]}`;
  return null;
}

// ── the assistant ──────────────────────────────────────────────────────────

export interface Hired {
  agent: Agent;
  teammate: Teammate;
}

/** Create the agent (or update its prompt) and make sure it is on the team. */
export async function hire(
  f: Fountain,
  userId: string,
  profile: Profile,
  opts: { vaultId?: string | null; environmentId?: string | null; connected?: ConnectedAccount[]; memory?: MemoryAttachment | null; messages?: MessagesAttachment | null },
): Promise<Hired> {
  const name = agentName(userId);
  const system = systemPrompt(profile, opts.connected ?? [], Boolean(opts.memory), Boolean(opts.messages));
  let agent = (await f.agents.list(name)).find((a) => a.name === name) ?? null;
  if (agent) {
    if (agent.system !== system) agent = await f.agents.update(agent.id, { system });
  } else {
    let model = DEFAULT_MODEL;
    try {
      const catalog = await f.catalog();
      const models = Object.values(catalog.models).flat();
      if (!models.includes(model)) model = models.find((m) => m.startsWith("anthropic/")) ?? models[0] ?? model;
    } catch {
      // the catalog is advisory
    }
    agent = await f.agents.create({
      name,
      description: "Reflex: a personal assistant with its own computer.",
      runtime: AGENT_RUNTIME,
      model,
      system,
      sandbox_mode: "persistent",
      ...(opts.environmentId ? { environment_id: opts.environmentId } : {}),
      ...(opts.vaultId ? { allowed_vault_ids: [opts.vaultId] } : {}),
    });
  }
  const teammate = await f.team.add(agent.id, {
    name: "Reflex",
    ...(opts.environmentId ? { environment_id: opts.environmentId } : {}),
    ...(opts.vaultId ? { vault_id: opts.vaultId } : {}),
  });
  return { agent, teammate };
}

/** The teammate, or null when it is gone. */
export async function roster(f: Fountain, agentId: string): Promise<Teammate | null> {
  try {
    return await f.team.get(agentId);
  } catch (err) {
    if (err instanceof NotFoundError) return null;
    throw err;
  }
}

export function presence(t: Teammate | null): AssistantView {
  if (!t) return { state: "none", label: "Not set up yet", hired: false };
  switch (t.presence.state) {
    case "working":
      return { state: "working", label: "Reflex is working", hired: true };
    case "starting":
      return { state: "waking", label: "Reflex is waking up its computer", hired: true };
    case "online":
      return { state: "ready", label: "Reflex is ready", hired: true };
    case "asleep":
    case "away":
    case "machine_offline":
    case "offline":
      return { state: "resting", label: "Reflex is resting", hired: true };
    case "failed":
      return { state: "trouble", label: "Reflex hit a problem", hired: true };
    default:
      return { state: "ready", label: t.presence.label, hired: true };
  }
}

// ── the thread ─────────────────────────────────────────────────────────────

export interface FoldedTurn {
  id: string;
  number: number;
  prompt: string;
  status: TurnView["status"];
  /** "autonomous" when the runtime continued on its own, not the owner */
  origin: "user" | "autonomous";
  at: string;
  endedAt: string | null;
  /** full reply text, block included */
  text: string;
  steps: string[];
}

/** Turns plus their output, folded from the blocks Fountain already parsed. */
export async function fold(f: Fountain, conversationId: string): Promise<FoldedTurn[]> {
  const conv = f.resume(conversationId);
  const [turns, events] = await Promise.all([conv.turns(), conv.history({ streams: ["stdout", "acp", "stage"] })]);
  const byTurn = new Map<string, { text: string; steps: string[] }>();
  for (const ev of events) {
    if (!ev.turn_id) continue;
    let acc = byTurn.get(ev.turn_id);
    if (!acc) {
      acc = { text: "", steps: [] };
      byTurn.set(ev.turn_id, acc);
    }
    absorb(acc, ev);
  }
  return [...turns]
    .sort((a, b) => a.turn_number - b.turn_number)
    .map((t) => {
      const acc = byTurn.get(t.id) ?? { text: "", steps: [] };
      return {
        id: t.id,
        number: t.turn_number,
        prompt: t.prompt,
        status: t.status,
        origin: t.origin === "autonomous" ? "autonomous" : "user",
        at: t.started_at ?? t.inserted_at ?? new Date(0).toISOString(),
        endedAt: t.ended_at ?? null,
        text: acc.text,
        steps: acc.steps,
      };
    });
}

/** Feed one event into a turn's accumulator; returns what changed for the live stream. */
export function absorb(acc: { text: string; steps: string[] }, ev: LogEvent): { text?: string; step?: string } {
  const out: { text?: string; step?: string } = {};
  if (ev.kind !== "output" || !ev.blocks) return out;
  for (const b of ev.blocks) {
    if (b.kind === "text" && b.body) {
      acc.text += b.body;
      out.text = (out.text ?? "") + b.body;
    } else if (b.kind === "tool_use") {
      const step = describeStep(b);
      if (step) {
        acc.steps.push(step);
        out.step = step;
      }
    }
  }
  return out;
}

/** A tool call as the owner reads it: "Looked at comcast.com", never a command line. */
export function describeStep(b: Block): string | null {
  const name = (b.name ?? "").toLowerCase();
  const summary = b.summary ?? "";
  const url = summary.match(/https?:\/\/[^\s"'<>)]+/)?.[0];
  const host = url ? safeHost(url) : null;
  if (name.includes("sms")) return "Sent a text";
  if (name.includes("email_send") || name.includes("email_reply")) return "Sent an email";
  if (name.includes("email")) return "Read email";
  if (name.includes("web") || name.includes("fetch") || name.includes("search") || name.includes("browser")) return host ? `Looked at ${host}` : "Searched the web";
  if (name.includes("write") || name.includes("edit")) return "Took notes";
  if (name.includes("read")) return "Checked its notes";
  if (name.includes("bash") || name.includes("shell") || name.includes("command") || name === "terminal") return host ? `Looked at ${host}` : "Worked on its computer";
  return host ? `Looked at ${host}` : null;
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function toTurnView(t: FoldedTurn): TurnView {
  const via = t.origin === "autonomous" ? "reflex" : (t.prompt.match(/^\[via (sms|email|routine)\]/)?.[1] as TurnView["via"] | undefined);
  return {
    id: t.id,
    number: t.number,
    prompt: t.prompt,
    via: via ?? "you",
    reply: stripUpdate(t.text),
    status: t.status,
    steps: t.steps,
    at: t.at,
    endedAt: t.endedAt,
  };
}

// ── routines ───────────────────────────────────────────────────────────────

export function toRoutineView(s: { id: string; name?: string | null; cron: string; prompt: string; enabled: boolean; next_run_at?: string | null; last_run_at?: string | null; last_error?: string | null }): RoutineView {
  return {
    id: s.id,
    title: s.name ?? "Routine",
    cron: s.cron,
    prompt: s.prompt,
    enabled: s.enabled,
    nextAt: s.next_run_at ?? null,
    lastAt: s.last_run_at ?? null,
    lastError: s.last_error ?? null,
  };
}

// ── contact (texting) ──────────────────────────────────────────────────────

export interface Contact {
  email: string | null;
  phone: string | null;
  prompt_from_number?: string | null;
  prompt_opted_out_at?: string | null;
}

export async function grantContact(f: Fountain, agentId: string, yourNumber: string): Promise<Contact> {
  const res = await f.request<{ data?: Contact } | Contact>("POST", `/api/team/${agentId}/contact`, { body: { prompt_from_number: yourNumber } });
  return unwrap(res);
}

export async function revokeContact(f: Fountain, agentId: string): Promise<void> {
  try {
    await f.request("DELETE", `/api/team/${agentId}/contact`);
  } catch (err) {
    if (!(err instanceof NotFoundError)) throw err;
  }
}

function unwrap<T>(v: { data?: T } | T): T {
  return v && typeof v === "object" && "data" in (v as object) && (v as { data?: T }).data ? (v as { data: T }).data! : (v as T);
}

// ── services: sign in once, Reflex gets the tools ──────────────────────────

/**
 * Every service Reflex means to offer, grouped the way the owner thinks about
 * them. Which ones are live is decided against Fountain at request time: a
 * service lights up when its provider is configured there and the scopes it
 * needs are requested, and shows as "soon" until then — so this list is the
 * roadmap and the live set at once, and nothing here needs touching when
 * Fountain grows a provider.
 */
export interface CatalogService {
  id: string;
  label: string;
  kind: "email" | "calendar" | "chat";
  /** the Fountain connection provider that backs it */
  provider: string;
  /** a requested/granted scope must match, or null when any connection of the provider covers it */
  scopeHint: RegExp | null;
}

export const SERVICE_CATALOG: CatalogService[] = [
  { id: "gmail", label: "Gmail", kind: "email", provider: "google", scopeHint: /gmail|mail\.google/i },
  { id: "outlook-mail", label: "Outlook", kind: "email", provider: "microsoft", scopeHint: /mail/i },
  { id: "gcal", label: "Google Calendar", kind: "calendar", provider: "google", scopeHint: /calendar/i },
  { id: "outlook-cal", label: "Outlook Calendar", kind: "calendar", provider: "microsoft", scopeHint: /calendar/i },
  { id: "slack", label: "Slack", kind: "chat", provider: "slack", scopeHint: null },
  { id: "teams", label: "Microsoft Teams", kind: "chat", provider: "microsoft", scopeHint: /chat|team/i },
];

export const SERVICE_KINDS: Array<{ kind: CatalogService["kind"]; title: string }> = [
  { kind: "email", title: "Email" },
  { kind: "calendar", title: "Calendar" },
  { kind: "chat", title: "Chat" },
];

/** Provider id → what the owner calls it, for a provider the catalog does not know. */
export function serviceLabel(provider: string): string {
  if (provider === "google") return "Google";
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}


/**
 * What this Fountain can connect and what this account has connected, or null
 * when the account cannot have connections at all (broker off, older server).
 */
export async function services(f: Fountain): Promise<{ providers: ConnectionProvider[]; connections: Connection[] } | null> {
  try {
    const [providers, connections] = await Promise.all([f.connections.providers.list(), f.connections.list()]);
    return { providers: providers.filter((p) => p.configured), connections };
  } catch (err) {
    if (err instanceof NotFoundError) return null;
    throw err;
  }
}

/** The active connections in the shape the system prompt describes them. */
export function connectedAccounts(providers: ConnectionProvider[], connections: Connection[]): ConnectedAccount[] {
  return connections
    .filter((c) => c.status === "active")
    .map((c) => {
      const p = providers.find((x) => x.slug === c.provider);
      return {
        provider: c.provider,
        label: p?.name ?? serviceLabel(c.provider),
        account: c.account_email ?? null,
        envKey: c.env_key,
        hosts: p?.token_hosts ?? [],
      };
    })
    .sort((a, b) => a.envKey.localeCompare(b.envKey));
}

/** How the memory MCP server is attached: the bridge URL plus the person's bearer. */
export interface MemoryAttachment {
  url: string;
  token: string;
}

/** How the paired-Mac MCP bridge is attached. */
export interface MessagesAttachment {
  url: string;
  token: string;
}

/**
 * Point the agent at the active connections and its memory. No-op when
 * nothing changed. Google gets a bare `{connection}`
 * `mcp_servers` entry (it resolves to Fountain's Gmail-served MCP server,
 * which refuses other providers — every other token is brokered into the
 * sandbox env automatically). Messages and memory use Reflex-hosted MCP
 * bridges, and the system prompt tells the agent which accounts and tools it
 * holds, or it would never know they exist.
 */
export async function syncServices(
  f: Fountain,
  agentId: string,
  profile: Profile,
  providers: ConnectionProvider[],
  connections: Connection[],
  memory: MemoryAttachment | null = null,
  messages: MessagesAttachment | null = null,
): Promise<void> {
  const desired: Record<string, unknown> = {};
  for (const c of connections) {
    if (c.status !== "active" || c.provider !== "google") continue;
    desired.gmail ??= { connection: c.id };
  }
  if (memory) desired.memory = { type: "http", url: memory.url, headers: { Authorization: `Bearer ${memory.token}` } };
  if (messages) desired.messages = { type: "http", url: messages.url, headers: { Authorization: `Bearer ${messages.token}` } };
  const system = systemPrompt(profile, connectedAccounts(providers, connections), Boolean(memory), Boolean(messages));
  const agent = await f.agents.get(agentId);
  const current = (agent.mcp_servers ?? {}) as Record<string, unknown>;
  const same =
    Object.keys(current).length === Object.keys(desired).length &&
    Object.entries(desired).every(([k, v]) => JSON.stringify(current[k]) === JSON.stringify(v));
  const patch: { mcp_servers?: typeof desired; system?: string } = {};
  if (!same) patch.mcp_servers = desired;
  if (agent.system !== system) patch.system = system;
  if (Object.keys(patch).length > 0) await f.agents.update(agentId, patch);
}

// ── the vault: connected accounts ──────────────────────────────────────────

export async function ensureVault(f: Fountain, userId: string): Promise<string> {
  const name = `${agentName(userId)}-accounts`;
  const existing = (await f.vaults.list(name)).find((v) => v.name === name);
  if (existing) return existing.id;
  const v = await f.vaults.create({ name, description: "Accounts Reflex may use. Values are write-only." });
  return v.id;
}

export function busy(err: unknown): boolean {
  return err instanceof ConversationBusyError;
}
