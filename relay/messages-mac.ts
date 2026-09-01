#!/usr/bin/env bun
/**
 * Reflex Messages relay for macOS.
 *
 * Reads ~/Library/Messages/chat.db locally and sends plain text through the
 * Messages scripting interface. It only makes outbound HTTPS requests to the
 * Reflex server. Run it as the same logged-in macOS user as Messages.app.
 */
import { Database } from "bun:sqlite";
import { chmod, mkdir } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";

interface RelayConfig {
  server: string;
  token: string;
  deviceId: string;
}

interface Command {
  id: string;
  method: "recent" | "thread" | "search" | "send";
  params: Record<string, unknown>;
}

async function main(): Promise<never> {
  const args = parseArgs(process.argv.slice(2));
  const configPath = args.config ?? join(homedir(), ".config", "reflex", "messages-relay.json");
  let config = await readConfig(configPath);

  if (args.server && args.code) {
    config = await pair(args.server, args.code, args.name ?? hostname());
    await saveConfig(configPath, config);
    console.log(`Paired ${args.name ?? hostname()} with Reflex. The device token is stored at ${configPath}.`);
  }
  if (!config) usage("No saved pairing. Pass --server and --code once.");

  const dbPath = args.database ?? join(homedir(), "Library", "Messages", "chat.db");
  let messages: MacMessages;
  try {
    messages = new MacMessages(dbPath);
    console.log(`Reading ${dbPath}`);
  } catch (err) {
    usage(`Could not open Messages: ${errorText(err)}\nGrant Full Disk Access to the terminal or Bun, then try again.`);
  }

  console.log(`Connected to ${config.server}. Leave this process running; Ctrl-C stops it.`);
  let delay = 1000;
  for (;;) {
    try {
      const res = await fetch(`${config.server}/api/messages/relay/poll`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.token}`, accept: "application/json" },
        signal: AbortSignal.timeout(40_000),
      });
      if (res.status === 204) {
        delay = 1000;
        continue;
      }
      if (res.status === 401) usage("This Mac was disconnected from Reflex. Pair it again from the Connections page.");
      if (!res.ok) throw new Error(`poll returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const command = (await res.json()) as Command;
      let result: unknown;
      let error: string | undefined;
      try {
        result = await messages.execute(command);
      } catch (err) {
        error = errorText(err);
      }
      const done = await fetch(`${config.server}/api/messages/relay/result`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
        body: JSON.stringify({ id: command.id, result, error }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!done.ok && done.status !== 404) throw new Error(`result returned ${done.status}`);
      delay = 1000;
    } catch (err) {
      console.error(`${new Date().toISOString()} ${errorText(err)}; retrying in ${Math.round(delay / 1000)}s`);
      await Bun.sleep(delay);
      delay = Math.min(delay * 2, 15_000);
    }
  }
}

export class MacMessages {
  private db: Database;

  constructor(path: string) {
    this.db = new Database(path, { readonly: true, strict: true });
    this.db.query("select count(*) as n from chat").get();
  }

  async execute(command: Command): Promise<unknown> {
    const limit = Math.max(1, Number(command.params.limit) || 20);
    if (command.method === "recent") return this.recent(Math.min(limit, 50));
    if (command.method === "thread") return this.thread(required(command.params.chat_guid, "chat_guid"), Math.min(limit, 100));
    if (command.method === "search") return this.search(required(command.params.query, "query"), Math.min(limit, 100));
    if (command.method === "send") return this.send(required(command.params.chat_guid, "chat_guid"), required(command.params.text, "text"));
    throw new Error(`unknown command ${String(command.method)}`);
  }

  private recent(limit: number): unknown[] {
    const rows = this.db
      .query<RecentRow, [number]>(
        `select c.guid as chat_guid,
                coalesce(nullif(c.display_name, ''), '') as display_name,
                group_concat(distinct h.id) as participants,
                max(m.date) as last_date
           from chat c
           join chat_message_join cmj on cmj.chat_id = c.rowid
           join message m on m.rowid = cmj.message_id
      left join chat_handle_join chj on chj.chat_id = c.rowid
      left join handle h on h.rowid = chj.handle_id
       group by c.rowid
       order by max(m.date) desc
          limit ?`,
      )
      .all(limit);
    const latest = this.db.query<MessageRow, [string]>(
      `select m.guid, m.text, m.date, m.is_from_me, h.id as sender, m.service
         from message m
         join chat_message_join cmj on cmj.message_id = m.rowid
         join chat c on c.rowid = cmj.chat_id
    left join handle h on h.rowid = m.handle_id
        where c.guid = ?
     order by m.date desc limit 1`,
    );
    return rows.map((r) => ({
      chat_guid: r.chat_guid,
      name: r.display_name || r.participants || "Unknown conversation",
      participants: splitParticipants(r.participants),
      last_at: appleDate(r.last_date),
      latest: normalizeMessage(latest.get(r.chat_guid)),
    }));
  }

  private thread(chatGuid: string, limit: number): unknown[] {
    const rows = this.db
      .query<MessageRow, [string, number]>(
        `select m.guid, m.text, m.date, m.is_from_me, h.id as sender, m.service,
                m.cache_has_attachments as has_attachments
           from message m
           join chat_message_join cmj on cmj.message_id = m.rowid
           join chat c on c.rowid = cmj.chat_id
      left join handle h on h.rowid = m.handle_id
          where c.guid = ?
            and coalesce(m.associated_message_type, 0) = 0
       order by m.date desc limit ?`,
      )
      .all(chatGuid, limit)
      .reverse();
    return rows.map(normalizeMessage);
  }

  private search(query: string, limit: number): unknown[] {
    const escaped = query.replace(/[\\%_]/g, (c) => `\\${c}`);
    const rows = this.db
      .query<SearchRow, [string, number]>(
        `select m.guid, m.text, m.date, m.is_from_me, h.id as sender, m.service,
                m.cache_has_attachments as has_attachments, c.guid as chat_guid,
                coalesce(nullif(c.display_name, ''), '') as display_name
           from message m
           join chat_message_join cmj on cmj.message_id = m.rowid
           join chat c on c.rowid = cmj.chat_id
      left join handle h on h.rowid = m.handle_id
          where m.text like ? escape '\\'
            and coalesce(m.associated_message_type, 0) = 0
       order by m.date desc limit ?`,
      )
      .all(`%${escaped}%`, limit);
    return rows.map((r) => ({ ...normalizeMessage(r), chat_guid: r.chat_guid, chat_name: r.display_name || r.sender || "Unknown conversation" }));
  }

  private async send(chatGuid: string, text: string): Promise<unknown> {
    const script = `on run argv
  set messageText to item 1 of argv
  tell application "Messages"
    set targetChat to a reference to chat id "${appleScriptString(chatGuid)}"
    send messageText to targetChat
  end tell
end run`;
    const proc = Bun.spawn(["osascript", "-e", script, text], { stdout: "pipe", stderr: "pipe" });
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (code !== 0) throw new Error(`Messages could not send: ${stderr.trim() || `osascript exited ${code}`}`);
    return { sent: true, chat_guid: chatGuid, at: new Date().toISOString() };
  }
}

interface RecentRow {
  chat_guid: string;
  display_name: string;
  participants: string | null;
  last_date: number;
}

interface MessageRow {
  guid: string;
  text: string | null;
  date: number;
  is_from_me: number;
  sender: string | null;
  service: string | null;
  has_attachments?: number;
}

interface SearchRow extends MessageRow {
  chat_guid: string;
  display_name: string;
}

function normalizeMessage(row: MessageRow | null): Record<string, unknown> | null {
  if (!row) return null;
  return {
    guid: row.guid,
    text: row.text ?? (row.has_attachments ? "[attachment]" : "[rich or empty message]"),
    at: appleDate(row.date),
    from_me: Boolean(row.is_from_me),
    sender: row.is_from_me ? "me" : row.sender,
    service: row.service,
    has_attachments: Boolean(row.has_attachments),
  };
}

function appleDate(raw: number): string | null {
  if (!Number.isFinite(Number(raw))) return null;
  const n = Number(raw);
  const millis = Math.abs(n) > 1e15 ? n / 1e6 : Math.abs(n) > 1e12 ? n / 1e3 : n * 1000;
  return new Date(Date.UTC(2001, 0, 1) + millis).toISOString();
}

function splitParticipants(value: string | null): string[] {
  return value ? value.split(",").filter(Boolean) : [];
}

function appleScriptString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]/g, "");
}

async function pair(server: string, code: string, name: string): Promise<RelayConfig> {
  const base = server.trim().replace(/\/+$/, "");
  if (!/^https:\/\//.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) usage("--server must use HTTPS (HTTP is allowed only for localhost).");
  const res = await fetch(`${base}/api/messages/relay/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ code: code.trim(), name: name.trim().slice(0, 80) }),
  });
  const body = (await res.json().catch(() => ({}))) as Partial<RelayConfig> & { message?: string };
  if (!res.ok || !body.token || !body.deviceId) usage(body.message ?? `Pairing failed (${res.status}).`);
  return { server: base, token: body.token, deviceId: body.deviceId };
}

async function readConfig(path: string): Promise<RelayConfig | null> {
  try {
    const parsed = JSON.parse(await Bun.file(path).text()) as RelayConfig;
    return parsed.server && parsed.token && parsed.deviceId ? parsed : null;
  } catch {
    return null;
  }
}

async function saveConfig(path: string, config: RelayConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await Bun.write(path, JSON.stringify(config, null, 2) + "\n");
  await chmod(path, 0o600);
}

function parseArgs(argv: string[]): { server?: string; code?: string; name?: string; config?: string; database?: string } {
  const out: { server?: string; code?: string; name?: string; config?: string; database?: string } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === "--server" && value) out.server = value;
    else if (key === "--code" && value) out.code = value;
    else if (key === "--name" && value) out.name = value;
    else if (key === "--config" && value) out.config = value;
    else if (key === "--database" && value) out.database = value;
    else if (key === "--help" || key === "-h") usage();
    else usage(`Unknown or incomplete option: ${key ?? ""}`);
    i += 1;
  }
  return out;
}

function required(value: unknown, name: string): string {
  const s = typeof value === "string" ? value.trim() : "";
  if (!s) throw new Error(`${name} is required`);
  return s;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function usage(error?: string): never {
  if (error) console.error(error);
  console.error(`Usage:
  bun run relay/messages-mac.ts --server https://reflex.example --code PAIRING_CODE [--name "Mac mini"]

After the first run, the saved pairing is used automatically:
  bun run relay/messages-mac.ts`);
  process.exit(error ? 1 : 0);
}

if (import.meta.main) await main();
