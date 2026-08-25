/**
 * The app's side of the contract: reads the ```reflex block out of a reply.
 * Tolerates a sloppy agent (bad JSON, missing fields) and never throws;
 * the worst case is an empty update, never a crashed watcher.
 */

export type JobStatus = "queued" | "working" | "needs-you" | "done" | "dropped";

export interface JobUpdate {
  key: string;
  title: string;
  status: JobStatus;
  note: string;
}

export type NotifyKind = "heads-up" | "done" | "needs-you";

export interface Notification {
  kind: NotifyKind;
  text: string;
}

export interface ReflexUpdate {
  jobs: JobUpdate[];
  memory: Record<string, string>;
  notify: Notification[];
}

const FENCE = /```reflex[^\S\n]*\n([\s\S]*?)```/g;
const STATUSES: JobStatus[] = ["queued", "working", "needs-you", "done", "dropped"];
const KINDS: NotifyKind[] = ["heads-up", "done", "needs-you"];
const KEY_RE = /^[a-z0-9-]{2,40}$/;

export const EMPTY: ReflexUpdate = { jobs: [], memory: {}, notify: [] };

/** The LAST well-formed block in a reply, merged over any earlier ones. */
export function parseUpdate(text: string): ReflexUpdate {
  const out: ReflexUpdate = { jobs: [], memory: {}, notify: [] };
  const seenJobs = new Map<string, JobUpdate>();
  for (const m of text.matchAll(FENCE)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(m[1]!.trim() || "{}");
    } catch {
      continue;
    }
    if (!isObj(parsed)) continue;
    if (Array.isArray(parsed.jobs)) {
      for (const j of parsed.jobs) {
        const job = asJob(j);
        if (job) seenJobs.set(job.key, job);
      }
    }
    if (isObj(parsed.memory)) {
      for (const [k, v] of Object.entries(parsed.memory)) {
        const key = k.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 60);
        if (!key) continue;
        out.memory[key] = typeof v === "string" ? v.slice(0, 500) : v == null ? "" : String(v).slice(0, 500);
      }
    }
    if (Array.isArray(parsed.notify)) {
      for (const n of parsed.notify) {
        const note = asNotify(n);
        if (note) out.notify.push(note);
      }
    }
  }
  out.jobs = [...seenJobs.values()];
  return out;
}

/** The reply as the owner reads it: without the block. */
export function stripUpdate(text: string): string {
  return text.replace(FENCE, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** Human status labels, one place. */
export const STATUS_LABEL: Record<JobStatus, string> = {
  queued: "Up next",
  working: "In progress",
  "needs-you": "Needs you",
  done: "Done",
  dropped: "Dropped",
};

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function asJob(v: unknown): JobUpdate | null {
  if (!isObj(v)) return null;
  const rawKey = str(v.key)?.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  const title = str(v.title);
  if (!rawKey || !KEY_RE.test(rawKey) || !title) return null;
  const status = STATUSES.includes(v.status as JobStatus) ? (v.status as JobStatus) : "working";
  return { key: rawKey, title: title.slice(0, 140), status, note: (str(v.note) ?? "").slice(0, 300) };
}

function asNotify(v: unknown): Notification | null {
  if (!isObj(v)) return null;
  const text = str(v.text);
  if (!text) return null;
  const kind = KINDS.includes(v.kind as NotifyKind) ? (v.kind as NotifyKind) : "heads-up";
  return { kind, text: text.slice(0, 300) };
}
