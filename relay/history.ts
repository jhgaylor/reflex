/**
 * Message history a relay keeps for itself, for apps whose client library
 * hands each message over once and stores nothing (Signal, WhatsApp). Chats,
 * contacts and messages in one SQLite file; the read commands come from here.
 *
 * Ids: a chat is whatever the app calls the conversation (a phone number, a
 * group id). Contacts may carry an alias — a Signal UUID, a WhatsApp LID —
 * that resolves to the canonical id so both spellings land in one chat.
 */
import { Database } from "bun:sqlite";

export interface Filed {
  at: number;
  text: string | null | undefined;
  attachments?: number;
  /** replaces a message already filed under this id instead of appending */
  id?: string;
}

export interface Who {
  fromMe: boolean;
  sender: string | null;
  senderName: string | null;
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

export class History {
  protected db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.run("pragma journal_mode = wal");
    this.db.run(`create table if not exists chats (id text primary key, name text, is_group integer not null default 0, last_at integer not null default 0)`);
    this.db.run(`create table if not exists contacts (id text primary key, canonical text, name text)`);
    this.db.run(`create table if not exists messages (
      id text primary key, chat_id text not null, sender text, sender_name text, text text not null,
      at integer not null, from_me integer not null default 0, has_attachments integer not null default 0
    )`);
    this.db.run("create index if not exists messages_chat_idx on messages (chat_id, at)");
  }

  /** Files one message; empty ones (no text, no attachment) are dropped. Returns whether it was kept. */
  file(chat: string, isGroup: boolean, m: Filed, who: Who): boolean {
    const attachments = m.attachments ?? 0;
    const text = m.text?.trim() || (attachments ? "[attachment]" : "");
    if (!text) return false;
    const at = Number(m.at) || Date.now();
    const id = m.id ?? `${chat}|${who.fromMe ? "me" : who.sender}|${at}`;
    this.db.run(
      `insert into messages (id, chat_id, sender, sender_name, text, at, from_me, has_attachments) values (?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (id) do update set text = excluded.text, has_attachments = excluded.has_attachments`,
      [id, chat, who.sender, who.senderName, text, at, who.fromMe ? 1 : 0, attachments ? 1 : 0],
    );
    this.touchChat(chat, isGroup, at, isGroup ? null : who.senderName);
    return true;
  }

  /** Rewrites the text of an already filed message; a no-op when it was never filed. */
  edit(id: string, text: string | null | undefined): void {
    if (text?.trim()) this.db.run("update messages set text = ? where id = ?", [text.trim(), id]);
  }

  recordOwn(chat: string, at: number, text: string, id?: string): void {
    this.file(chat, chat.endsWith("@g.us") || chat.startsWith("group:"), { at, text, id }, { fromMe: true, sender: null, senderName: null });
  }

  /** `id` may be an alias; `canonical` is what chats are keyed by. */
  rememberContact(id: string, canonical: string | null, name: string | null): void {
    this.db.run(
      `insert into contacts (id, canonical, name) values (?, ?, ?)
       on conflict (id) do update set canonical = coalesce(excluded.canonical, contacts.canonical), name = coalesce(excluded.name, contacts.name)`,
      [id, canonical, name],
    );
    if (name) this.db.run("update chats set name = ? where id = ? and is_group = 0", [name, canonical ?? id]);
  }

  rememberGroup(id: string, name: string | null): void {
    this.db.run("insert into chats (id, name, is_group, last_at) values (?, ?, 1, 0) on conflict (id) do update set name = coalesce(excluded.name, chats.name)", [id, name]);
  }

  /** The canonical id for an alias, or the alias itself when nothing better is known. */
  resolve(id: string): string {
    const row = this.db.query<{ canonical: string | null }, [string]>("select canonical from contacts where id = ?").get(id);
    return row?.canonical ?? id;
  }

  knowsChat(id: string): boolean {
    return Boolean(this.db.query("select 1 from chats where id = ?").get(id)) || Boolean(this.db.query("select 1 from contacts where id = ? or canonical = ?").get(id, id));
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

  private chatName(id: string, stored: string | null): string {
    if (stored) return stored;
    const contact = this.db.query<{ name: string | null }, [string]>("select name from contacts where canonical = ? and name is not null limit 1").get(id);
    return contact?.name ?? (id.endsWith("@g.us") || id.startsWith("group:") ? "Unnamed group" : id);
  }

  private touchChat(id: string, isGroup: boolean, at: number, name: string | null): void {
    this.db.run(
      `insert into chats (id, name, is_group, last_at) values (?, ?, ?, ?)
       on conflict (id) do update set last_at = max(chats.last_at, excluded.last_at), name = coalesce(chats.name, excluded.name)`,
      [id, name, isGroup ? 1 : 0, at],
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
