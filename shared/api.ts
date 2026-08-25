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

export interface MemoryView {
  key: string;
  value: string;
  updatedAt: string;
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
  /** connected accounts: the keys the assistant can use, values never leave the server */
  accounts: Array<{ key: string; label: string; addedAt: string }>;
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
