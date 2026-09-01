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
import crypto from "node:crypto";
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
  /** when the person's memory brain was provisioned, or null before it exists */
  memoryProvisionedAt: Date | null;
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
  // Messages on a paired Mac. Pairing codes and device credentials are
  // digest-only; the MCP bearer is sealed because Reflex must give it back to
  // Fountain whenever it rebuilds the agent's tool configuration.
  `create table if not exists message_pairings (
     code_digest text primary key,
     user_id integer not null references users(id) on delete cascade,
     expires_at timestamptz not null,
     used_at timestamptz
   )`,
  `create table if not exists message_devices (
     id text primary key,
     user_id integer not null references users(id) on delete cascade,
     name text not null,
     token_digest text not null unique,
     created_at timestamptz not null default now(),
     last_seen_at timestamptz,
     revoked_at timestamptz
   )`,
  `create index if not exists message_devices_user_idx on message_devices (user_id, created_at desc)`,
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
  // Memory brains (engram). The token is what the agent's computer presents to
  // the memory MCP endpoint: sealed so a leaked table is not a set of brains,
  // digest-indexed so a request can be resolved to its person.
  `alter table users add column if not exists memory_token text`,
  `alter table users add column if not exists memory_token_digest text`,
  `alter table users add column if not exists memory_provisioned_at timestamptz`,
  `create index if not exists users_memory_token_idx on users (memory_token_digest)`,
  `alter table users add column if not exists messages_token text`,
  `alter table users add column if not exists messages_token_digest text`,
  `create index if not exists users_messages_token_idx on users (messages_token_digest)`,
  // The server's engram signing identity, sealed. Materialized to disk at
  // boot so a restarted pod signs as the same identity it always did.
  `create table if not exists engram_files (
     path text primary key,
     content text not null,
     created_at timestamptz not null default now()
   )`,
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
    memoryProvisionedAt: r.memory_provisioned_at ? new Date(r.memory_provisioned_at as string) : null,
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

// ── memory brains (engram) ─────────────────────────────────────────────────

/** The person's memory bearer token, minting one on first ask. */
export async function memoryToken(sql: Sql, secret: string, userId: number): Promise<string | null> {
  const rows = await sql<{ memory_token: string | null }>`select memory_token from users where id = ${userId}`;
  if (!rows[0]) return null;
  const existing = open(rows[0].memory_token, secret);
  if (existing) return existing;
  const token = newMemoryToken();
  await sql`update users set memory_token = ${seal(token, secret)}, memory_token_digest = ${tokenDigest(token)} where id = ${userId}`;
  return token;
}

function newMemoryToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** Resolve a memory MCP request's bearer token to its person. */
export async function userByMemoryToken(sql: Sql, token: string): Promise<User | null> {
  const rows = await sql`select * from users where memory_token_digest = ${tokenDigest(token)}`;
  return rows[0] ? toUser(rows[0]) : null;
}

export async function markMemoryProvisioned(sql: Sql, userId: number): Promise<void> {
  await sql`update users set memory_provisioned_at = now() where id = ${userId} and memory_provisioned_at is null`;
}

// ── Messages on a paired Mac ──────────────────────────────────────────────

export interface MessageDeviceRow {
  id: string;
  name: string;
  createdAt: Date;
  lastSeenAt: Date | null;
}

/** MCP bearer presented by the agent's sandbox. */
export async function messagesToken(sql: Sql, secret: string, userId: number): Promise<string | null> {
  const rows = await sql<{ messages_token: string | null }>`select messages_token from users where id = ${userId}`;
  if (!rows[0]) return null;
  const existing = open(rows[0].messages_token, secret);
  if (existing) return existing;
  const token = newSecretToken();
  await sql`update users set messages_token = ${seal(token, secret)}, messages_token_digest = ${tokenDigest(token)} where id = ${userId}`;
  return token;
}

export async function userByMessagesToken(sql: Sql, token: string): Promise<User | null> {
  const rows = await sql`select * from users where messages_token_digest = ${tokenDigest(token)}`;
  return rows[0] ? toUser(rows[0]) : null;
}

/** One ten-minute code shown in the browser and claimed by the Mac. */
export async function createMessagePairing(sql: Sql, userId: number): Promise<{ code: string; expiresAt: Date }> {
  const code = crypto.randomBytes(9).toString("base64url").toUpperCase();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await sql`delete from message_pairings where user_id = ${userId} or expires_at < now()`;
  await sql`insert into message_pairings (code_digest, user_id, expires_at) values (${tokenDigest(code)}, ${userId}, ${expiresAt})`;
  return { code, expiresAt };
}

/** Atomically consumes a pairing code and returns the new device credential. */
export async function claimMessagePairing(
  sql: Sql,
  code: string,
  name: string,
): Promise<{ user: User; device: MessageDeviceRow; token: string } | null> {
  const rows = await sql<{ user_id: number | string }>`
    update message_pairings set used_at = now()
    where code_digest = ${tokenDigest(code.trim().toUpperCase())} and used_at is null and expires_at > now()
    returning user_id`;
  if (!rows[0]) return null;
  const userId = Number(rows[0].user_id);
  const token = newSecretToken();
  const id = crypto.randomUUID();
  const made = await sql`
    insert into message_devices (id, user_id, name, token_digest)
    values (${id}, ${userId}, ${name.slice(0, 80)}, ${tokenDigest(token)}) returning *`;
  const user = await userById(sql, userId);
  return user && made[0] ? { user, device: toMessageDevice(made[0]), token } : null;
}

export async function messageDeviceByToken(sql: Sql, token: string): Promise<{ user: User; device: MessageDeviceRow } | null> {
  const rows = await sql`select * from message_devices where token_digest = ${tokenDigest(token)} and revoked_at is null`;
  if (!rows[0]) return null;
  const user = await userById(sql, Number(rows[0].user_id));
  return user ? { user, device: toMessageDevice(rows[0]) } : null;
}

export async function touchMessageDevice(sql: Sql, id: string): Promise<void> {
  await sql`update message_devices set last_seen_at = now() where id = ${id} and revoked_at is null`;
}

export async function listMessageDevices(sql: Sql, userId: number): Promise<MessageDeviceRow[]> {
  const rows = await sql`select * from message_devices where user_id = ${userId} and revoked_at is null order by created_at desc`;
  return rows.map(toMessageDevice);
}

export async function revokeMessageDevice(sql: Sql, userId: number, id: string): Promise<void> {
  await sql`update message_devices set revoked_at = now() where user_id = ${userId} and id = ${id}`;
}

function toMessageDevice(r: Record<string, unknown>): MessageDeviceRow {
  return {
    id: String(r.id),
    name: String(r.name),
    createdAt: new Date(r.created_at as string),
    lastSeenAt: r.last_seen_at ? new Date(r.last_seen_at as string) : null,
  };
}

function newSecretToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/**
 * One person's engram keystore files, sealed at rest and keyed under a
 * per-person prefix (`u<id>/identity.json`, …); the map's keys are the
 * relative paths. Empty when none saved yet.
 */
export async function engramFiles(sql: Sql, secret: string, userId: number): Promise<Map<string, Buffer>> {
  const rows = await sql<{ path: string; content: string }>`select path, content from engram_files where path like ${`u${userId}/%`}`;
  const out = new Map<string, Buffer>();
  const prefix = `u${userId}/`;
  for (const r of rows) {
    const b64 = open(r.content, secret);
    if (b64 !== null) out.set(r.path.slice(prefix.length), Buffer.from(b64, "base64"));
  }
  return out;
}

export async function saveEngramFiles(sql: Sql, secret: string, userId: number, files: Map<string, Buffer>): Promise<void> {
  for (const [path, content] of files) {
    await sql`
      insert into engram_files (path, content) values (${`u${userId}/${path}`}, ${seal(content.toString("base64"), secret)})
      on conflict (path) do update set content = excluded.content`;
  }
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
