/**
 * The contract between the Reflex page and the Reflex server. Everything the
 * browser sees comes through here, in the owner's vocabulary: no agents,
 * sandboxes, schedules or vaults. The server translates to Fountain.
 */
import type { Guardrails } from "./spec";
import type { JobStatus, NotifyKind } from "./protocol";

export type SetupStep = "profile" | "reach" | "accounts" | "done";

export interface Me {
  signedIn: boolean;
  email?: string;
  setupStep?: SetupStep;
  profile?: ProfileView;
  assistant?: AssistantView;
}

export interface ProfileView {
  name: string;
  timezone: string;
  about: string;
  guardrails: Guardrails;
}

/** "Reflex is …" — the presence line, already in plain words. */
export type AssistantState = "working" | "waking" | "ready" | "resting" | "trouble" | "none";

export interface AssistantView {
  state: AssistantState;
  label: string;
  /** true once the agent exists on Fountain */
  hired: boolean;
}

export interface TurnView {
  id: string;
  number: number;
  /** what the owner (or a routine, or a text) said */
  prompt: string;
  /** where the prompt came from */
  via: "you" | "sms" | "email" | "routine" | "reflex";
  /** the reply, block stripped; grows while the turn runs */
  reply: string;
  status: "pending" | "running" | "completed" | "failed" | "interrupted";
  /** one line per thing the assistant did, in plain words */
  steps: string[];
  at: string;
  endedAt: string | null;
}

export interface ThreadView {
  turns: TurnView[];
  assistant: AssistantView;
  /** messages the owner sent while the assistant was busy, not yet delivered */
  queued: number;
}

export interface JobView {
  key: string;
  title: string;
  status: JobStatus;
  note: string;
  createdAt: string;
  updatedAt: string;
}

/** One remembered thing, as engram's visible views hand it back. */
export interface MemoryEntryView {
  /** null on rows the timeline view returns without one; those cannot be forgotten from the page */
  id: string | null;
  content: string;
  category: string;
  /** who wrote it: the assistant, the owner ("human"), or "import" for migrated facts */
  source: string;
  at: string | null;
  tags: string[];
  /** decays unless reinforced; null when the view does not report it */
  strength: number | null;
  tier: string | null;
}

export interface MemoryPage {
  /** false while the brain is not provisioned or the backend is not answering */
  ready: boolean;
  reason: string | null;
  entries: MemoryEntryView[];
}

export interface NotificationView {
  id: number;
  kind: NotifyKind;
  text: string;
  at: string;
  read: boolean;
}

export interface RoutineView {
  id: string;
  title: string;
  cron: string;
  prompt: string;
  enabled: boolean;
  nextAt: string | null;
  lastAt: string | null;
  lastError: string | null;
}

export interface ConnectionsView {
  /** can this account have a phone number and inbox at all */
  texting: { available: boolean; reason: string | null };
  contact: { email: string | null; phone: string | null; yourNumber: string | null; optedOut: boolean } | null;
  /** sign in once and Reflex gets the tools; Fountain holds the credential */
  services: ServicesView;
  /** connected accounts: the keys the assistant can use, values never leave the server */
  accounts: Array<{ key: string; label: string; addedAt: string }>;
}

export interface ServicesView {
  available: boolean;
  reason: string | null;
  /** email, calendar, chat — every service Reflex means to offer, whatever its state today */
  groups: Array<{ kind: string; title: string; services: ServiceView[] }>;
}

export interface ServiceView {
  id: string;
  label: string;
  /** connected: signed in and working. offered: one click away. revoked: needs a fresh sign-in. soon: not on Fountain yet. */
  state: "connected" | "offered" | "revoked" | "soon";
  email: string | null;
  connectionId: string | null;
  connectUrl: string | null;
}

export interface PlanView {
  /** null when the Fountain instance does not bill */
  balanceCents: number | null;
  /** roughly what an hour of the assistant working costs */
  hourCents: number | null;
  addUrl: string | null;
}

/** Server-sent events on GET /api/stream. */
export type StreamEvent =
  | { type: "turn"; state: "started" | "done" | "failed" | "interrupted"; turnId: string | null }
  | { type: "text"; turnId: string | null; text: string }
  | { type: "step"; turnId: string | null; text: string }
  | { type: "jobs" }
  | { type: "notify"; notification: NotificationView }
  | { type: "assistant"; assistant: AssistantView }
  | { type: "hello" };

export interface ApiErrorBody {
  error: string;
  message: string;
}
