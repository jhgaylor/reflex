/**
 * Memory: each person gets an engram brain — a Postgres database of signed,
 * classified, decaying entries — and the agent gets the seven engram tools
 * over MCP. Three pieces live here:
 *
 * 1. The signing identity. One per Reflex deployment, created headless on
 *    first boot, sealed into `engram_files`, and materialized back to disk on
 *    every boot, so a restarted pod signs as the identity it always did.
 * 2. Brains. `ensureBrain` creates `reflex_brain_<id>` next to the app
 *    database, runs `engram init` against it (idempotent: schema, roles,
 *    identity publish), and folds the person's legacy memory key-values in
 *    as imported entries.
 * 3. The bridge. `engram mcp serve` only speaks stdio, and the agent's
 *    computer can only reach us over HTTPS, so the server keeps one child
 *    process per active brain and forwards JSON-RPC both ways. The agent's
 *    `mcp_servers` entry points at POST /api/mcp/memory with a per-person
 *    bearer; nothing about the database is visible from the sandbox.
 *
 * Everything shells out to the same binary the CLI user runs (`ENGRAM_BIN`),
 * so the owner-facing memory API reads through the exact visibility surface
 * the agent writes through.
 */
import type { Subprocess } from "bun";
import crypto from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import type { Config } from "./config";
import { connect } from "./db";
import { fixed, listMemory, setMemory, engramFiles, saveEngramFiles, markMemoryProvisioned, type Sql, type User } from "./store";

/** Thrown when memory cannot serve; the API turns it into "not ready" + reason. */
export class MemoryUnavailable extends Error {}

const IDLE_KILL_MS = 10 * 60 * 1000;
const CALL_TIMEOUT_MS = 120_000;
const CLI_TIMEOUT_MS = 60_000;

/** What the agent's mcp_servers entry needs; null when memory cannot be attached. */
export interface MemoryAttachment {
  url: string;
  token: string;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

interface Child {
  proc: Subprocess<"pipe", "pipe", "pipe">;
  pending: Map<number, { clientId: number | string | null; resolve: (m: JsonRpcMessage) => void; timer: ReturnType<typeof setTimeout> }>;
  nextId: number;
  initResult: unknown;
  lastUsed: number;
  ready: Promise<void>;
  dead: boolean;
}

export class Memory {
  private children = new Map<number, Child>();
  private provisioning = new Map<number, Promise<void>>();
  private reaper: ReturnType<typeof setInterval>;

  constructor(
    private sql: Sql,
    private secret: string,
    private cfg: Pick<Config, "databaseUrl" | "engramBin" | "engramHome">,
  ) {
    this.reaper = setInterval(() => this.reap(), 60_000);
  }

  close(): void {
    clearInterval(this.reaper);
    for (const [userId] of this.children) this.kill(userId);
  }

  // ── the signing identities ───────────────────────────────────────────────
  //
  // One keystore per person, not one shared: `keys publish` stamps the brain's
  // engram_users row id into the local identity.json sidecar, and that id is
  // database-generated — a shared sidecar would hold whichever brain published
  // last, and every other brain's writes would be refused as unpublished.

  /** Whether the engram binary answers at all; decides memory up or down at boot. */
  async probe(): Promise<boolean> {
    try {
      return (await this.run(["version"])).code === 0;
    } catch {
      return false;
    }
  }

  private userHome(userId: number): string {
    return `${this.cfg.engramHome}/u${userId}`;
  }

  private configDir(userId: number): string {
    return `${this.userHome(userId)}/.config/engram`;
  }

  /** Sealed keystore → disk, once per person per process; a fresh pod starts empty. */
  private materialized = new Set<number>();

  private async materialize(userId: number): Promise<void> {
    if (this.materialized.has(userId)) return;
    const dir = this.configDir(userId);
    if (!(await Bun.file(`${dir}/identity.json`).exists())) {
      const saved = await engramFiles(this.sql, this.secret, userId);
      for (const [path, content] of saved) {
        if (path === "RECOVERY.txt") continue; // sealed for safekeeping, not for disk
        const abs = `${dir}/${path}`;
        await Bun.write(abs, content);
        await chmod(abs, 0o600);
      }
    }
    this.materialized.add(userId);
  }

  /** Disk keystore → sealed rows; called whenever engram may have restamped the sidecar. */
  private async sealKeystore(userId: number, extra?: Map<string, Buffer>): Promise<void> {
    const dir = this.configDir(userId);
    const files = new Map<string, Buffer>(extra);
    // `dot: true` is load-bearing: on a host with no OS keyring — this
    // container — the AES data key that unseals every keys/*.enc file lives
    // in `.encryption_key`, and a keystore restored without it cannot sign.
    const glob = new Bun.Glob("**/*");
    for await (const f of glob.scan({ cwd: dir, onlyFiles: true, dot: true })) {
      files.set(f, Buffer.from(await Bun.file(`${dir}/${f}`).arrayBuffer()));
    }
    await saveEngramFiles(this.sql, this.secret, userId, files);
  }

  // ── brains ───────────────────────────────────────────────────────────────

  brainUrl(userId: number): string {
    if (!this.cfg.databaseUrl) throw new MemoryUnavailable("no database");
    const u = new URL(this.cfg.databaseUrl);
    u.pathname = `/reflex_brain_${userId}`;
    return u.toString();
  }

  /** Create and initialize the person's brain; idempotent, serialized per person. */
  async ensureBrain(user: User): Promise<void> {
    if (user.memoryProvisionedAt) return;
    const inflight = this.provisioning.get(user.id);
    if (inflight) return inflight;
    const p = this.provision(user).finally(() => this.provisioning.delete(user.id));
    this.provisioning.set(user.id, p);
    return p;
  }

  private async provision(user: User): Promise<void> {
    const name = `reflex_brain_${user.id}`;
    try {
      await this.sql(fixed(`create database ${name}`));
    } catch (err) {
      // 42P04 duplicate_database: another boot got here first; fine.
      if (!/already exists/i.test(err instanceof Error ? err.message : String(err))) throw err;
    }
    const brainUrl = this.brainUrl(user.id);
    // pgvector is not trusted, so this succeeds only where the extension is
    // already in template1 (k8s/postgres.yaml postInitTemplateSQL) or the
    // role is superuser; either way engram's baseline needs the type.
    const brain = connect(brainUrl);
    try {
      await brain(fixed("create extension if not exists vector"));
    } catch (err) {
      console.warn(`memory ${user.id}: create extension vector: ${err instanceof Error ? err.message : String(err)}`);
    }
    await this.joinEngramRoles(brain).catch(() => undefined);

    // The signing identity, first. A headless host has no OS keyring, and
    // engram's keystore hard-fails on a keyring *transport* error unless the
    // Rust-compatible data-key file is already planted — planting it is the
    // supported headless path (seal.go), so plant it. The recovery key then
    // lands on stderr; it is sealed away with the keystore, never logged.
    await this.materialize(user.id);
    const dir = this.configDir(user.id);
    let recovery: Map<string, Buffer> | undefined;
    if (!(await Bun.file(`${dir}/identity.json`).exists())) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(`${dir}/.encryption_key`, crypto.randomBytes(32).toString("base64"), { mode: 0o600, flag: "wx" }).catch((err) => {
        if ((err as { code?: string }).code !== "EEXIST") throw err;
      });
      const made = await this.run(["keys", "init", "--display-name", "Reflex"], user.id);
      if (made.code !== 0) throw new MemoryUnavailable(`keys init failed: ${made.err.slice(0, 400)}`);
      if (made.err.trim()) recovery = new Map([["RECOVERY.txt", Buffer.from(made.err)]]);
    }

    // Schema, migrations, and the publish that stamps the sidecar's user id —
    // the sealed keystore is saved only after, so a restored pod signs writes.
    let init = await this.run(["init", "--db-url", brainUrl], user.id);
    if (init.code !== 0) {
      // On a brand-new cluster the baseline creates the engram roles mid-init
      // and migration 008's DROP OWNED immediately needs membership in them —
      // which CREATEROLE does not confer. Join the roles that now exist and
      // resume; engram tracks applied migrations, so this picks up at 008.
      await this.joinEngramRoles(brain).catch(() => undefined);
      init = await this.run(["init", "--db-url", brainUrl], user.id);
    }
    if (init.code !== 0) throw new MemoryUnavailable(`engram init failed: ${init.err.slice(0, 400)}`);
    await this.sealKeystore(user.id, recovery);

    // Fold the legacy key-value memory in as imported entries, then retire it.
    const legacy = await listMemory(this.sql, user.id);
    for (const m of legacy) {
      const put = await this.run([
        "capture",
        `${m.key.replace(/_/g, " ")}: ${m.value}`,
        "--db-url",
        brainUrl,
        "--category",
        "context",
        "--source",
        "import",
        "--created-by",
        "owner",
        "--tags",
        "reflex-import",
        "--no-embed",
      ], user.id);
      if (put.code !== 0) throw new MemoryUnavailable(`import failed: ${put.err.slice(0, 400)}`);
    }
    for (const m of legacy) await setMemory(this.sql, user.id, m.key, "");
    await markMemoryProvisioned(this.sql, user.id);
    console.log(`memory ${user.id}: brain provisioned${legacy.length ? ` (${legacy.length} facts imported)` : ""}`);
  }

  /**
   * Membership in the engram roles, granted to ourselves. engram's migration
   * 008 runs `DROP OWNED BY engram_reader/writer`, which requires membership;
   * on Postgres 16+ CREATEROLE gives their creator only ADMIN OPTION — enough
   * to grant membership, not to hold it. Engram assumes superuser here; we
   * are not one, so we join instead. Idempotent, cluster-wide, best-effort.
   */
  private async joinEngramRoles(brain: Sql): Promise<void> {
    await brain(
      fixed(`do $$
        declare r text;
        begin
          for r in select rolname from pg_roles where rolname like 'engram%' and not pg_has_role(current_user, rolname, 'member')
          loop
            begin
              execute format('grant %I to %I', r, current_user);
            exception when others then null;
            end;
          end loop;
        end $$`),
    );
  }

  /** Nightly upkeep: decay, promote, dedup, archive — engram's consolidation. */
  async consolidateAll(userIds: number[]): Promise<void> {
    for (const id of userIds) {
      await this.materialize(id).catch(() => undefined);
      const res = await this.run(["consolidate", "--db-url", this.brainUrl(id)], id).catch((err) => ({ code: -1, out: "", err: String(err) }));
      if (res.code !== 0) console.warn(`memory ${id}: consolidate failed: ${res.err.slice(0, 200)}`);
    }
  }

  // ── the MCP bridge ───────────────────────────────────────────────────────

  /**
   * One HTTP body in, one HTTP body out. `initialize` is answered from the
   * child's own handshake (each client session gets the same server card);
   * notifications are absorbed — the child's session is already initialized —
   * and requests are forwarded with remapped ids so parallel client sessions
   * cannot collide.
   */
  async handleMcp(userId: number, body: unknown): Promise<{ status: number; body: unknown | null }> {
    if (Array.isArray(body)) {
      const answers: unknown[] = [];
      for (const m of body) {
        const one = await this.handleMcp(userId, m);
        if (one.body !== null) answers.push(one.body);
      }
      return answers.length ? { status: 200, body: answers } : { status: 202, body: null };
    }
    const msg = body as JsonRpcMessage;
    if (!msg || typeof msg !== "object" || typeof msg.method !== "string") {
      return { status: 400, body: { jsonrpc: "2.0", id: null, error: { code: -32600, message: "not a JSON-RPC message" } } };
    }
    const child = await this.child(userId);
    child.lastUsed = Date.now();
    if (msg.method === "initialize") {
      return { status: 200, body: { jsonrpc: "2.0", id: msg.id ?? null, result: child.initResult } };
    }
    if (msg.id === undefined || msg.id === null) return { status: 202, body: null };
    const answer = await this.forward(child, msg);
    return { status: 200, body: answer };
  }

  private forward(child: Child, msg: JsonRpcMessage): Promise<JsonRpcMessage> {
    const id = child.nextId++;
    return new Promise<JsonRpcMessage>((resolve) => {
      const timer = setTimeout(() => {
        child.pending.delete(id);
        resolve({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "memory timed out" } });
      }, CALL_TIMEOUT_MS);
      child.pending.set(id, { clientId: msg.id ?? null, resolve, timer });
      this.write(child, { ...msg, id });
    });
  }

  private async child(userId: number): Promise<Child> {
    const existing = this.children.get(userId);
    if (existing && !existing.dead) {
      await existing.ready;
      return existing;
    }
    await this.materialize(userId); // engram_capture signs; a fresh pod needs the keystore back first
    const proc = Bun.spawn([this.cfg.engramBin, "mcp", "serve", "--db-url", this.brainUrl(userId)], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: this.env(userId),
    });
    const child: Child = { proc, pending: new Map(), nextId: 1, initResult: null, lastUsed: Date.now(), ready: Promise.resolve(), dead: false };
    child.ready = this.handshake(child);
    this.children.set(userId, child);
    void this.read(child);
    void proc.exited.then(() => this.retire(userId, child));
    await child.ready;
    return child;
  }

  private async handshake(child: Child): Promise<void> {
    const answer = await new Promise<JsonRpcMessage>((resolve) => {
      const timer = setTimeout(() => {
        child.pending.delete(0);
        resolve({ error: { code: -32000, message: "engram did not answer initialize" } });
      }, 15_000);
      child.pending.set(0, { clientId: 0, resolve, timer });
      this.write(child, {
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "reflex", version: "1" } },
      });
    });
    if (!answer.result) {
      child.dead = true;
      child.proc.kill();
      throw new MemoryUnavailable("memory backend did not start");
    }
    child.initResult = answer.result;
    this.write(child, { jsonrpc: "2.0", method: "notifications/initialized" });
  }

  private write(child: Child, msg: JsonRpcMessage): void {
    try {
      child.proc.stdin.write(JSON.stringify(msg) + "\n");
      void child.proc.stdin.flush();
    } catch {
      child.dead = true;
    }
  }

  private async read(child: Child): Promise<void> {
    let buf = "";
    const decoder = new TextDecoder();
    const reader = child.proc.stdout.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let msg: JsonRpcMessage;
          try {
            msg = JSON.parse(line) as JsonRpcMessage;
          } catch {
            continue;
          }
          if (typeof msg.id !== "number") continue; // a server-side notification; nobody upstream to give it to
          const waiter = child.pending.get(msg.id);
          if (!waiter) continue;
          child.pending.delete(msg.id);
          clearTimeout(waiter.timer);
          waiter.resolve({ ...msg, id: waiter.clientId });
        }
      }
    } catch {
      // stream closed; retire() settles the rest
    }
  }

  private retire(userId: number, child: Child): void {
    child.dead = true;
    for (const [, waiter] of child.pending) {
      clearTimeout(waiter.timer);
      waiter.resolve({ jsonrpc: "2.0", id: waiter.clientId, error: { code: -32000, message: "memory backend restarted; try again" } });
    }
    child.pending.clear();
    if (this.children.get(userId) === child) this.children.delete(userId);
  }

  private kill(userId: number): void {
    const child = this.children.get(userId);
    if (!child) return;
    this.children.delete(userId);
    child.dead = true;
    child.proc.kill();
  }

  private reap(): void {
    const now = Date.now();
    for (const [userId, child] of this.children) {
      if (child.pending.size === 0 && now - child.lastUsed > IDLE_KILL_MS) this.kill(userId);
    }
  }

  // ── the owner's view ─────────────────────────────────────────────────────

  /** Recent entries, or a search when `q` is given, through engram's visible views. */
  async entries(userId: number, q: string | null): Promise<MemoryEntry[]> {
    await this.materialize(userId);
    const url = this.brainUrl(userId);
    const args = q ? ["search", q, "--db-url", url, "--limit", "50"] : ["timeline", "--db-url", url, "--limit", "50"];
    const res = await this.run(args, userId);
    if (res.code !== 0) throw new MemoryUnavailable(`engram read failed: ${res.err.slice(0, 300)}`);
    return parseEntries(res.out);
  }

  async capture(userId: number, content: string, category: string): Promise<void> {
    await this.materialize(userId);
    const res = await this.run(["capture", content, "--db-url", this.brainUrl(userId), "--category", category, "--source", "human", "--created-by", "owner"], userId);
    if (res.code !== 0) throw new MemoryUnavailable(`could not save: ${res.err.slice(0, 300)}`);
  }

  async archive(userId: number, entryId: string, reason: string): Promise<void> {
    await this.materialize(userId);
    const res = await this.run(["archive", entryId, "--db-url", this.brainUrl(userId), "--reason", reason], userId);
    if (res.code !== 0) throw new MemoryUnavailable(`could not forget: ${res.err.slice(0, 300)}`);
  }

  // ── running the binary ───────────────────────────────────────────────────

  /**
   * XDG_CONFIG_HOME pins the person's own keystore; ENGRAM_SESSION keeps each
   * person's tier file their own (without a TTY it would fall back to the
   * parent pid — this whole server). DATABASE_URL is deliberately not passed:
   * every invocation names its brain with --db-url, and the app database must
   * never be a fallback.
   */
  private env(userId?: number): Record<string, string> {
    const pass = ["PATH", "ENGRAM_INFERENCE_PROVIDER", "INFERENCE_PROVIDER", "OPENROUTER_API_KEY", "OPENROUTER_CHAT_MODEL", "OPENAI_API_KEY", "OLLAMA_HOST"];
    const home = userId === undefined ? `${this.cfg.engramHome}/probe` : this.userHome(userId);
    const env: Record<string, string> = {
      HOME: home,
      XDG_CONFIG_HOME: `${home}/.config`,
      ENGRAM_SESSION: userId === undefined ? "reflex-server" : `reflex-${userId}`,
    };
    for (const k of pass) if (process.env[k]) env[k] = process.env[k]!;
    return env;
  }

  private async run(args: string[], userId?: number): Promise<{ code: number; out: string; err: string }> {
    let proc: Subprocess<"ignore", "pipe", "pipe">;
    try {
      proc = Bun.spawn([this.cfg.engramBin, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: this.env(userId) });
    } catch (err) {
      throw new MemoryUnavailable(`memory backend not installed (${err instanceof Error ? err.message : String(err)})`);
    }
    const killer = setTimeout(() => proc.kill(), CLI_TIMEOUT_MS);
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(killer);
    return { code, out, err };
  }
}

// ── entry normalization ──────────────────────────────────────────────────────

export interface MemoryEntry {
  id: string | null;
  content: string;
  category: string;
  source: string;
  at: string | null;
  tags: string[];
  strength: number | null;
  tier: string | null;
}

/**
 * `engram search|timeline --format json` rows. Search hands back a bare
 * array of full entries (`vitality` is the decaying strength, 1 = fully
 * held); timeline wraps `{since, count, events}` where each event is only
 * `{timestamp, event_type, summary, id}`. Field names are engram's to
 * evolve, so a row we cannot make sense of is dropped, not fatal.
 */
export function parseEntries(raw: string): MemoryEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object"
      ? ((parsed as Record<string, unknown>).events ??
        (parsed as Record<string, unknown>).results ??
        (parsed as Record<string, unknown>).entries ??
        (parsed as Record<string, unknown>).data ??
        [])
      : [];
  if (!Array.isArray(rows)) return [];
  const out: MemoryEntry[] = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const row = r as Record<string, unknown>;
    const s = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
    const content = s(row.content) ?? s(row.summary) ?? s(row.body) ?? s(row.text);
    if (!content) continue;
    const strength = typeof row.vitality === "number" ? row.vitality : typeof row.strength === "number" ? row.strength : null;
    out.push({
      id: s(row.id) ?? s(row.entry_id) ?? s(row.uuid),
      content,
      category: s(row.category) ?? s(row.kind) ?? prettyEventType(s(row.event_type)) ?? "note",
      source: s(row.source) ?? "",
      at: s(row.occurred_at) ?? s(row.created_at) ?? s(row.timestamp) ?? s(row.at) ?? s(row.ts),
      tags: Array.isArray(row.tags) ? row.tags.filter((t): t is string => typeof t === "string") : [],
      strength,
      tier: s(row.memory_tier) ?? s(row.tier),
    });
  }
  return out;
}

function prettyEventType(t: string | null): string | null {
  return t ? t.replace(/_/g, " ") : null;
}

/** The categories the owner can file a fact under from the page. */
export const OWNER_CATEGORIES = ["context", "person", "insight", "decision", "idea"] as const;
