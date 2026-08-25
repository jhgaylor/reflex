/**
 * The database. One Fountain key per person (theirs, sealed), and the things
 * Fountain has no table for: jobs, memory, notifications, which accounts
 * were connected, and the messages waiting for a busy assistant.
 *
 * Every read and write is by `userId`; nothing here takes a Fountain id from
 * a request. Migrations are `create ... if not exists`, applied at boot.
 */
import type { JobStatus, NotifyKind } from "../shared/protocol";
import { DEFAULT_GUARDRAILS, type Profile } from "../shared/spec";
import type { SetupStep } from "../shared/api";
import { open, seal } from "./secretbox";
import { SESSION_TTL_SECONDS, tokenDigest } from "./session";

export type Sql = {
  <T = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>;
};

export interface User {
  id: number;
  email: string;
  fountainUrl: string;
  agentId: string | null;
  conversationId: string | null;
  vaultId: string | null;
  profile: Profile;
  setupStep: SetupStep;
}

export interface JobRow {
  key: string;
  title: string;
  status: JobStatus;
  note: string;
  createdAt: Date;
  updatedAt: Date;
}

const SCHEMA: string[] = [
  `create table if not exists users (
     id serial primary key,
     email text not null,
     fountain_url text not null,
     fountain_key text not null,
     agent_id text,
     conversation_id text,
     vault_id text,
     profile jsonb not null default '{}'::jsonb,
     setup_step text not null default 'profile',
     created_at timestamptz not null default now(),
     unique (email, fountain_url)
   )`,
  `create table if not exists sessions (
     token_digest text primary key,
     user_id integer not null references users(id) on delete cascade,
     expires_at timestamptz not null
   )`,
  `create table if not exists jobs (
     user_id integer not null references users(id) on delete cascade,
     key text not null,
     title text not null,
     status text not null,
     note text not null default '',
     created_at timestamptz not null default now(),
     updated_at timestamptz not null default now(),
     primary key (user_id, key)
   )`,
  `create table if not exists memory (
     user_id integer not null references users(id) on delete cascade,
     key text not null,
     value text not null,
     updated_at timestamptz not null default now(),
     primary key (user_id, key)
   )`,
  `create table if not exists notifications (
     id serial primary key,
     user_id integer not null references users(id) on delete cascade,
     kind text not null,
     text text not null,
     read boolean not null default false,
     created_at timestamptz not null default now()
   )`,
  `create table if not exists accounts (
     user_id integer not null references users(id) on delete cascade,
     key text not null,
     label text not null,
     added_at timestamptz not null default now(),
     primary key (user_id, key)
   )`,
  `create table if not exists outbox (
     id serial primary key,
     user_id integer not null references users(id) on delete cascade,
     text text not null,
     created_at timestamptz not null default now()
   )`,
  `create table if not exists cursors (
     user_id integer primary key references users(id) on delete cascade,
     last_event_id bigint not null default 0
   )`,
  `create index if not exists notifications_user_idx on notifications (user_id, created_at desc)`,
];

/** A real template object for a fixed statement; the driver wants `raw`. */
export function fixed(text: string): TemplateStringsArray {
  const strings = [text] as string[] & { raw: string[] };
  strings.raw = [text];
  return strings as unknown as TemplateStringsArray;
}

export async function migrate(sql: Sql): Promise<void> {
  for (const stmt of SCHEMA) await sql(fixed(stmt));
}

// ── users and sessions ─────────────────────────────────────────────────────

function toUser(r: Record<string, unknown>): User {
  const p = (r.profile ?? {}) as Partial<Profile>;
  return {
    id: Number(r.id),
    email: String(r.email),
    fountainUrl: String(r.fountain_url),
    agentId: (r.agent_id as string | null) ?? null,
    conversationId: (r.conversation_id as string | null) ?? null,
    vaultId: (r.vault_id as string | null) ?? null,
    profile: {
      name: p.name ?? "",
      timezone: p.timezone ?? "UTC",
      about: p.about ?? "",
      guardrails: { ...DEFAULT_GUARDRAILS, ...(p.guardrails ?? {}) },
    },
    setupStep: (r.setup_step as SetupStep) ?? "profile",
  };
}

/** Sign in: create or update the person, always keeping the newest key. */
export async function upsertUser(sql: Sql, secret: string, input: { email: string; fountainUrl: string; apiKey: string }): Promise<User> {
  const email = input.email.trim().toLowerCase();
  const rows = await sql`
    insert into users (email, fountain_url, fountain_key)
    values (${email}, ${input.fountainUrl}, ${seal(input.apiKey, secret)})
    on conflict (email, fountain_url) do update set fountain_key = excluded.fountain_key
    returning *`;
  return toUser(rows[0]!);
}

export async function userById(sql: Sql, id: number): Promise<User | null> {
  const rows = await sql`select * from users where id = ${id}`;
  return rows[0] ? toUser(rows[0]) : null;
}

export async function usersWithAssistant(sql: Sql): Promise<User[]> {
  const rows = await sql`select * from users where agent_id is not null`;
  return rows.map(toUser);
}

export async function fountainKey(sql: Sql, secret: string, userId: number): Promise<string | null> {
  const rows = await sql<{ fountain_key: string }>`select fountain_key from users where id = ${userId}`;
  return open(rows[0]?.fountain_key, secret);
}

export async function updateUser(
  sql: Sql,
  userId: number,
  patch: Partial<{ agentId: string | null; conversationId: string | null; vaultId: string | null; profile: Profile; setupStep: SetupStep }>,
): Promise<User> {
  const rows = await sql`
    update users set
      agent_id = coalesce(${patch.agentId ?? null}, agent_id),
      conversation_id = coalesce(${patch.conversationId ?? null}, conversation_id),
      vault_id = coalesce(${patch.vaultId ?? null}, vault_id),
      profile = coalesce(${patch.profile ? JSON.stringify(patch.profile) : null}::jsonb, profile),
      setup_step = coalesce(${patch.setupStep ?? null}, setup_step)
    where id = ${userId} returning *`;
  return toUser(rows[0]!);
}

export async function createSession(sql: Sql, userId: number, token: string): Promise<void> {
  const expires = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  await sql`insert into sessions (token_digest, user_id, expires_at) values (${tokenDigest(token)}, ${userId}, ${expires})`;
}

export async function userForSession(sql: Sql, token: string): Promise<User | null> {
  const rows = await sql`
    select u.* from sessions s join users u on u.id = s.user_id
    where s.token_digest = ${tokenDigest(token)} and s.expires_at > now()`;
  return rows[0] ? toUser(rows[0]) : null;
}

export async function deleteSession(sql: Sql, token: string): Promise<void> {
  await sql`delete from sessions where token_digest = ${tokenDigest(token)}`;
}

// ── jobs ───────────────────────────────────────────────────────────────────

function toJob(r: Record<string, unknown>): JobRow {
  return {
    key: String(r.key),
    title: String(r.title),
    status: r.status as JobStatus,
    note: String(r.note ?? ""),
    createdAt: new Date(r.created_at as string),
    updatedAt: new Date(r.updated_at as string),
  };
}

export async function listJobs(sql: Sql, userId: number): Promise<JobRow[]> {
  const rows = await sql`select * from jobs where user_id = ${userId} order by updated_at desc`;
  return rows.map(toJob);
}

export async function upsertJob(sql: Sql, userId: number, job: { key: string; title: string; status: JobStatus; note: string }): Promise<JobRow> {
  const rows = await sql`
    insert into jobs (user_id, key, title, status, note) values (${userId}, ${job.key}, ${job.title}, ${job.status}, ${job.note})
    on conflict (user_id, key) do update set title = excluded.title, status = excluded.status, note = excluded.note, updated_at = now()
    returning *`;
  return toJob(rows[0]!);
}

export async function setJobStatus(sql: Sql, userId: number, key: string, status: JobStatus): Promise<JobRow | null> {
  const rows = await sql`update jobs set status = ${status}, updated_at = now() where user_id = ${userId} and key = ${key} returning *`;
  return rows[0] ? toJob(rows[0]) : null;
}

// ── memory ─────────────────────────────────────────────────────────────────

export async function listMemory(sql: Sql, userId: number): Promise<Array<{ key: string; value: string; updatedAt: Date }>> {
  const rows = await sql`select key, value, updated_at from memory where user_id = ${userId} order by key`;
  return rows.map((r) => ({ key: String(r.key), value: String(r.value), updatedAt: new Date(r.updated_at as string) }));
}

export async function setMemory(sql: Sql, userId: number, key: string, value: string): Promise<void> {
  if (value === "") {
    await sql`delete from memory where user_id = ${userId} and key = ${key}`;
    return;
  }
  await sql`
    insert into memory (user_id, key, value) values (${userId}, ${key}, ${value})
    on conflict (user_id, key) do update set value = excluded.value, updated_at = now()`;
}

// ── notifications ──────────────────────────────────────────────────────────

export interface NotificationRow {
  id: number;
  kind: NotifyKind;
  text: string;
  read: boolean;
  createdAt: Date;
}

function toNotification(r: Record<string, unknown>): NotificationRow {
  return { id: Number(r.id), kind: r.kind as NotifyKind, text: String(r.text), read: Boolean(r.read), createdAt: new Date(r.created_at as string) };
}

export async function addNotification(sql: Sql, userId: number, kind: NotifyKind, text: string): Promise<NotificationRow> {
  const rows = await sql`insert into notifications (user_id, kind, text) values (${userId}, ${kind}, ${text}) returning *`;
  return toNotification(rows[0]!);
}

export async function listNotifications(sql: Sql, userId: number, limit = 50): Promise<NotificationRow[]> {
  const rows = await sql`select * from notifications where user_id = ${userId} order by created_at desc limit ${limit}`;
  return rows.map(toNotification);
}

export async function markNotificationsRead(sql: Sql, userId: number): Promise<void> {
  await sql`update notifications set read = true where user_id = ${userId} and read = false`;
}

// ── accounts (labels only; the values live in the Fountain vault) ──────────

export async function listAccounts(sql: Sql, userId: number): Promise<Array<{ key: string; label: string; addedAt: Date }>> {
  const rows = await sql`select key, label, added_at from accounts where user_id = ${userId} order by added_at`;
  return rows.map((r) => ({ key: String(r.key), label: String(r.label), addedAt: new Date(r.added_at as string) }));
}

export async function addAccount(sql: Sql, userId: number, key: string, label: string): Promise<void> {
  await sql`
    insert into accounts (user_id, key, label) values (${userId}, ${key}, ${label})
    on conflict (user_id, key) do update set label = excluded.label, added_at = now()`;
}

export async function removeAccount(sql: Sql, userId: number, key: string): Promise<void> {
  await sql`delete from accounts where user_id = ${userId} and key = ${key}`;
}

// ── outbox: messages waiting for a busy assistant ──────────────────────────

export async function enqueue(sql: Sql, userId: number, text: string): Promise<void> {
  await sql`insert into outbox (user_id, text) values (${userId}, ${text})`;
}

export async function queued(sql: Sql, userId: number): Promise<number> {
  const rows = await sql<{ n: number | string }>`select count(*)::int as n from outbox where user_id = ${userId}`;
  return Number(rows[0]?.n ?? 0);
}

export async function nextQueued(sql: Sql, userId: number): Promise<{ id: number; text: string } | null> {
  const rows = await sql`select id, text from outbox where user_id = ${userId} order by id limit 1`;
  return rows[0] ? { id: Number(rows[0].id), text: String(rows[0].text) } : null;
}

export async function dequeue(sql: Sql, id: number): Promise<void> {
  await sql`delete from outbox where id = ${id}`;
}

// ── stream cursor ──────────────────────────────────────────────────────────

export async function cursor(sql: Sql, userId: number): Promise<number> {
  const rows = await sql<{ last_event_id: number | string }>`select last_event_id from cursors where user_id = ${userId}`;
  return Number(rows[0]?.last_event_id ?? 0);
}

export async function saveCursor(sql: Sql, userId: number, lastEventId: number): Promise<void> {
  await sql`
    insert into cursors (user_id, last_event_id) values (${userId}, ${lastEventId})
    on conflict (user_id) do update set last_event_id = greatest(cursors.last_event_id, excluded.last_event_id)`;
}
