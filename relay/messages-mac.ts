#!/usr/bin/env bun
/**
 * Reflex Messages relay for macOS.
 *
 * Reads ~/Library/Messages/chat.db locally and sends plain text through the
 * Messages scripting interface. It only makes outbound HTTPS requests to the
 * Reflex server. Run it as the same logged-in macOS user as Messages.app.
 */
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultConfigPath, errorText, loadPairing, makeUsage, parseArgs, required, serve, type Command } from "./transport";

const usage = makeUsage(`Usage:
  bun run relay/messages-mac.ts --server https://reflex.example --code PAIRING_CODE [--name "Mac mini"]

After the first run, the saved pairing is used automatically:
  bun run relay/messages-mac.ts`);

async function main(): Promise<never> {
  const args = parseArgs(process.argv.slice(2), usage);
  const config = await loadPairing("imessage", args, args.config ?? defaultConfigPath("imessage"), usage);

  const dbPath = args.database ?? join(homedir(), "Library", "Messages", "chat.db");
  let messages: MacMessages;
  try {
    messages = new MacMessages(dbPath);
    console.log(`Reading ${dbPath}`);
  } catch (err) {
    usage(`Could not open Messages: ${errorText(err)}\nGrant Full Disk Access to the terminal or Bun, then try again.`);
  }
  return serve("imessage", config, (command) => messages.execute(command), usage);
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
    if (command.method === "thread") return this.thread(required(command.params.chat_id, "chat_id"), Math.min(limit, 100));
    if (command.method === "search") return this.search(required(command.params.query, "query"), Math.min(limit, 100));
    if (command.method === "send") return this.send(required(command.params.chat_id, "chat_id"), required(command.params.text, "text"));
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

if (import.meta.main) await main();
