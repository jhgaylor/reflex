#!/usr/bin/env bun
/**
 * Reflex Signal relay.
 *
 * Drives signal-cli (linked to the owner's phone as a secondary device) over
 * its JSON-RPC stdio mode. signal-cli hands each message over exactly once
 * and keeps no history, so this relay stores what it receives in its own
 * SQLite file; history starts the moment the device was linked. It only
 * makes outbound HTTPS requests to the Reflex server.
 */
import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { defaultConfigPath, errorText, loadPairing, makeUsage, parseArgs, required, serve, type Command } from "./transport";

const CONTACT_REFRESH_MS = 15 * 60 * 1000;

const usage = makeUsage(`Usage:
  bun run relay/signal.ts --link [--name "Reflex relay"]        link this host to your Signal account (scan the QR code with your phone)
  bun run relay/signal.ts --server https://reflex.example --code PAIRING_CODE [--name "Mac mini"]

After the first run, the saved pairing is used automatically:
  bun run relay/signal.ts

Options: --account +15551234567 (when signal-cli has several), --database PATH (message history), --config PATH`);

async function main(): Promise<never> {
  const args = parseArgs(process.argv.slice(2), usage);
  if (args.link) {
    await link(args.name ?? "Reflex relay");
    if (!args.server) {
      console.log("Next: open Connections → Signal → Pair a relay in Reflex and run the command it shows.");
      process.exit(0);
    }
  }

  const config = await loadPairing("signal", args, args.config ?? defaultConfigPath("signal"), usage);
  const account = args.account ?? (await pickAccount());
  const dbPath = args.database ?? join(homedir(), ".local", "share", "reflex", "signal-history.sqlite");
  await mkdir(dirname(dbPath), { recursive: true, mode: 0o700 });
  const store = new SignalStore(dbPath);
  console.log(`Keeping Signal history for ${account} in ${dbPath}`);

  const rpc = new SignalCli(account, (envelope) => {
    try {
      store.ingest(envelope);
    } catch (err) {
      console.error(`could not store a message: ${errorText(err)}`);
    }
  });
  const refresh = async () => {
    try {
      store.rememberContacts((await rpc.call("listContacts", {})) as ContactRow[]);
      store.rememberGroups((await rpc.call("listGroups", {})) as GroupRow[]);
    } catch (err) {
      console.error(`could not refresh Signal contacts: ${errorText(err)}`);
    }
  };
  await refresh();
  setInterval(refresh, CONTACT_REFRESH_MS).unref();

  return serve("signal", config, (command) => execute(command, store, rpc), usage);
}

async function execute(command: Command, store: SignalStore, rpc: SignalCli): Promise<unknown> {
  const limit = Math.max(1, Number(command.params.limit) || 20);
  if (command.method === "recent") return store.recent(Math.min(limit, 50));
  if (command.method === "thread") return store.thread(required(command.params.chat_id, "chat_id"), Math.min(limit, 100));
  if (command.method === "search") return store.search(required(command.params.query, "query"), Math.min(limit, 100));
  if (command.method === "send") {
    const chatId = required(command.params.chat_id, "chat_id");
    const text = required(command.params.text, "text");
    if (!store.knowsChat(chatId)) throw new Error("Unknown chat_id; use one returned by a read tool.");
    const params = chatId.startsWith("group:") ? { groupId: chatId.slice(6), message: text } : { recipient: [chatId], message: text };
    const answer = (await rpc.call("send", params)) as { timestamp?: number; results?: Array<{ type?: string; recipientAddress?: unknown }> };
    const failed = (answer.results ?? []).filter((r) => r.type && r.type !== "SUCCESS");
    if (failed.length > 0) throw new Error(`Signal could not deliver: ${failed.map((r) => r.type).join(", ")}`);
    const at = answer.timestamp ?? Date.now();
    store.recordOwn(chatId, at, text);
    return { sent: true, chat_id: chatId, at: new Date(at).toISOString() };
  }
  throw new Error(`unknown command ${String(command.method)}`);
}

// ── history ────────────────────────────────────────────────────────────────

/** A trimmed view of what signal-cli emits as `params.envelope` on receive. */
export interface Envelope {
  source?: string | null;
  sourceNumber?: string | null;
  sourceUuid?: string | null;
  sourceName?: string | null;
  timestamp?: number;
  dataMessage?: DataMessage | null;
  editMessage?: { targetSentTimestamp?: number; dataMessage?: DataMessage | null } | null;
  syncMessage?: {
    sentMessage?: (DataMessage & { destination?: string | null; destinationNumber?: string | null; destinationUuid?: string | null }) | null;
  } | null;
}

interface DataMessage {
  timestamp?: number;
  message?: string | null;
  attachments?: unknown[];
  groupInfo?: { groupId?: string; type?: string } | null;
  reaction?: unknown;
  remoteDelete?: unknown;
}

interface ContactRow {
  number?: string | null;
  uuid?: string | null;
  name?: string | null;
  profile?: { givenName?: string | null; familyName?: string | null } | null;
}

interface GroupRow {
  id: string;
  name?: string | null;
}

interface StoredMessage {
  id: string;
  chat_id: string;
  sender: string | null;
  sender_name: string | null;
  text: string;
  at: number;
  from_me: number;
  has_attachments: number;
}

export class SignalStore {
  private db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.run("pragma journal_mode = wal");
    this.db.run(`create table if not exists chats (id text primary key, name text, is_group integer not null default 0, last_at integer not null default 0)`);
    this.db.run(`create table if not exists contacts (id text primary key, number text, name text)`);
    this.db.run(`create table if not exists messages (
      id text primary key, chat_id text not null, sender text, sender_name text, text text not null,
      at integer not null, from_me integer not null default 0, has_attachments integer not null default 0
    )`);
    this.db.run("create index if not exists messages_chat_idx on messages (chat_id, at)");
  }

  /** Files an incoming, edited or phone-sent message; everything else (receipts, typing, reactions) is dropped. */
  ingest(envelope: Envelope): void {
    const sent = envelope.syncMessage?.sentMessage;
    if (sent) {
      const chat = sent.groupInfo?.groupId ? `group:${sent.groupInfo.groupId}` : this.canon(sent.destinationNumber ?? sent.destination, sent.destinationUuid);
      if (chat) this.file(chat, sent, { fromMe: true, sender: null, senderName: null });
      return;
    }
    const edit = envelope.editMessage;
    const data = edit?.dataMessage ?? envelope.dataMessage;
    if (!data) return;
    const sender = this.canon(envelope.sourceNumber ?? envelope.source, envelope.sourceUuid);
    const chat = data.groupInfo?.groupId ? `group:${data.groupInfo.groupId}` : sender;
    if (!chat) return;
    const at = edit?.targetSentTimestamp ?? data.timestamp;
    this.file(chat, { ...data, timestamp: at }, { fromMe: false, sender, senderName: envelope.sourceName ?? null });
  }

  private file(chat: string, data: DataMessage, who: { fromMe: boolean; sender: string | null; senderName: string | null }): void {
    if (data.reaction || data.remoteDelete || data.groupInfo?.type === "UPDATE") return;
    const attachments = data.attachments?.length ?? 0;
    const text = data.message?.trim() || (attachments ? "[attachment]" : "");
    if (!text) return;
    const at = Number(data.timestamp) || Date.now();
    const id = `${chat}|${who.fromMe ? "me" : who.sender}|${at}`;
    this.db.run(
      `insert into messages (id, chat_id, sender, sender_name, text, at, from_me, has_attachments) values (?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (id) do update set text = excluded.text, has_attachments = excluded.has_attachments`,
      [id, chat, who.sender, who.senderName, text, at, who.fromMe ? 1 : 0, attachments ? 1 : 0],
    );
    this.touchChat(chat, at, who.senderName);
  }

  recordOwn(chat: string, at: number, text: string): void {
    this.file(chat, { timestamp: at, message: text }, { fromMe: true, sender: null, senderName: null });
  }

  rememberContacts(rows: ContactRow[]): void {
    for (const c of rows) {
      const id = c.number ?? c.uuid;
      if (!id) continue;
      const name = c.name?.trim() || [c.profile?.givenName, c.profile?.familyName].filter(Boolean).join(" ").trim() || null;
      if (c.uuid) this.db.run("insert into contacts (id, number, name) values (?, ?, ?) on conflict (id) do update set number = excluded.number, name = excluded.name", [c.uuid, c.number ?? null, name]);
      if (c.number) this.db.run("insert into contacts (id, number, name) values (?, ?, ?) on conflict (id) do update set name = excluded.name", [c.number, c.number, name]);
      if (name) this.db.run("update chats set name = ? where id = ? and is_group = 0", [name, id]);
    }
  }

  rememberGroups(rows: GroupRow[]): void {
    for (const g of rows) {
      if (!g.id) continue;
      this.db.run("insert into chats (id, name, is_group, last_at) values (?, ?, 1, 0) on conflict (id) do update set name = coalesce(excluded.name, chats.name)", [`group:${g.id}`, g.name ?? null]);
    }
  }

  knowsChat(id: string): boolean {
    return Boolean(this.db.query("select 1 from chats where id = ?").get(id)) || Boolean(this.db.query("select 1 from contacts where id = ?").get(id));
  }

  recent(limit: number): unknown[] {
    const rows = this.db.query<{ id: string; name: string | null; is_group: number; last_at: number }, [number]>("select * from chats where last_at > 0 order by last_at desc limit ?").all(limit);
    const latest = this.db.query<StoredMessage, [string]>("select * from messages where chat_id = ? order by at desc limit 1");
    return rows.map((c) => ({
      chat_id: c.id,
      chat_name: this.chatName(c.id, c.name),
      is_group: Boolean(c.is_group),
      last_at: new Date(c.last_at).toISOString(),
      latest: normalize(latest.get(c.id)),
    }));
  }

  thread(chatId: string, limit: number): unknown[] {
    const rows = this.db.query<StoredMessage, [string, number]>("select * from messages where chat_id = ? order by at desc limit ?").all(chatId, limit);
    return rows.reverse().map((m) => normalize(m));
  }

  search(query: string, limit: number): unknown[] {
    const rows = this.db
      .query<StoredMessage & { chat_name: string | null }, [string, number]>(
        `select m.*, c.name as chat_name from messages m left join chats c on c.id = m.chat_id
          where instr(lower(m.text), lower(?)) > 0 order by m.at desc limit ?`,
      )
      .all(query, limit);
    return rows.map((m) => ({ ...normalize(m), chat_id: m.chat_id, chat_name: this.chatName(m.chat_id, m.chat_name) }));
  }

  /** A phone number when signal-cli knows one, otherwise the account UUID. */
  private canon(number: string | null | undefined, uuid: string | null | undefined): string | null {
    if (number) return number;
    if (!uuid) return null;
    const known = this.db.query<{ number: string | null }, [string]>("select number from contacts where id = ?").get(uuid);
    return known?.number ?? uuid;
  }

  private chatName(id: string, stored: string | null): string {
    if (stored) return stored;
    const contact = this.db.query<{ name: string | null }, [string]>("select name from contacts where id = ?").get(id);
    return contact?.name ?? (id.startsWith("group:") ? "Unnamed group" : id);
  }

  private touchChat(id: string, at: number, senderName: string | null): void {
    const name = id.startsWith("group:") ? null : senderName;
    this.db.run(
      `insert into chats (id, name, is_group, last_at) values (?, ?, ?, ?)
       on conflict (id) do update set last_at = max(chats.last_at, excluded.last_at), name = coalesce(chats.name, excluded.name)`,
      [id, name, id.startsWith("group:") ? 1 : 0, at],
    );
  }
}

function normalize(m: StoredMessage | null): Record<string, unknown> | null {
  if (!m) return null;
  return {
    text: m.text,
    at: new Date(m.at).toISOString(),
    from_me: Boolean(m.from_me),
    sender: m.from_me ? "me" : m.sender_name || m.sender,
    has_attachments: Boolean(m.has_attachments),
  };
}

// ── signal-cli ─────────────────────────────────────────────────────────────

interface RpcReply {
  id?: string;
  method?: string;
  params?: { envelope?: Envelope };
  result?: unknown;
  error?: { message?: string };
}

/** signal-cli in `jsonRpc` mode: one JSON object per line each way; receive notifications arrive unprompted. */
class SignalCli {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private waiting = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private seq = 0;

  constructor(
    private account: string,
    private onEnvelope: (envelope: Envelope) => void,
  ) {
    this.start();
  }

  call(method: string, params: Record<string, unknown>): Promise<unknown> {
    const proc = this.proc;
    if (!proc?.stdin || typeof proc.stdin === "number") return Promise.reject(new Error("signal-cli is restarting; try again in a moment."));
    const id = `r${++this.seq}`;
    const stdin = proc.stdin;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`signal-cli did not answer ${method} in time`));
      }, 30_000);
      this.waiting.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      stdin.flush();
    });
  }

  private start(): void {
    const proc = Bun.spawn(["signal-cli", "-a", this.account, "jsonRpc", "--ignore-stories", "--ignore-stickers", "--ignore-avatars"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.proc = proc;
    void this.readLines(proc.stdout as ReadableStream<Uint8Array>, (line) => this.handle(line));
    void this.readLines(proc.stderr as ReadableStream<Uint8Array>, (line) => {
      if (/(warn|error)/i.test(line)) console.error(`signal-cli: ${line}`);
    });
    void proc.exited.then((code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      for (const [, w] of this.waiting) w.reject(new Error("signal-cli stopped"));
      this.waiting.clear();
      console.error(`signal-cli exited with ${code}; restarting in 5s`);
      setTimeout(() => this.start(), 5000);
    });
  }

  private handle(line: string): void {
    let msg: RpcReply;
    try {
      msg = JSON.parse(line) as RpcReply;
    } catch {
      return;
    }
    if (msg.method === "receive" && msg.params?.envelope) {
      this.onEnvelope(msg.params.envelope);
      return;
    }
    if (typeof msg.id !== "string") return;
    const w = this.waiting.get(msg.id);
    if (!w) return;
    this.waiting.delete(msg.id);
    if (msg.error) w.reject(new Error(msg.error.message ?? "signal-cli error"));
    else w.resolve(msg.result);
  }

  private async readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let nl = buffered.indexOf("\n");
      while (nl >= 0) {
        const line = buffered.slice(0, nl).trim();
        buffered = buffered.slice(nl + 1);
        if (line) onLine(line);
        nl = buffered.indexOf("\n");
      }
    }
  }
}

// ── setup helpers ──────────────────────────────────────────────────────────

/** The accounts signal-cli has on this host; the relay needs exactly one, or --account. */
async function pickAccount(): Promise<string> {
  const proc = Bun.spawn(["signal-cli", "listAccounts"], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if ((await proc.exited) !== 0) usage(`signal-cli is not working: ${err.trim() || "listAccounts failed"}. Install it with \`brew install signal-cli\`.`);
  const numbers = [...out.matchAll(/^Number:\s*(\S+)/gm)].map((m) => m[1]!);
  if (numbers.length === 0) usage("signal-cli is not linked to a Signal account yet. Run with --link first.");
  if (numbers.length > 1) usage(`signal-cli has several accounts (${numbers.join(", ")}); pass --account.`);
  return numbers[0]!;
}

/** Runs `signal-cli link` and shows the QR code the phone scans (Settings → Linked devices). */
async function link(name: string): Promise<void> {
  const proc = Bun.spawn(["signal-cli", "link", "-n", name], { stdout: "pipe", stderr: "pipe" });
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  let uri = "";
  const decoder = new TextDecoder();
  while (!uri.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    uri += decoder.decode(value, { stream: true });
  }
  uri = uri.split("\n")[0]?.trim() ?? "";
  if (!uri.startsWith("sgnl://")) {
    const err = await new Response(proc.stderr).text();
    usage(`signal-cli did not produce a linking URI: ${err.trim() || uri}`);
  }
  const qr = Bun.spawnSync(["qrencode", "-t", "ANSIUTF8", uri], { stdout: "pipe", stderr: "pipe" });
  if (qr.success) console.log(qr.stdout.toString());
  else console.log(`Install qrencode to see a QR code here, or make one from this URI:\n${uri}\n`);
  console.log(`On your phone: Signal → Settings → Linked devices → Link new device, then scan. Waiting…`);
  const code = await proc.exited;
  if (code !== 0) usage(`Linking failed: ${(await new Response(proc.stderr).text()).trim() || `signal-cli exited ${code}`}`);
  console.log("Linked. signal-cli will finish syncing contacts on its first run.");
}

if (import.meta.main) await main();
