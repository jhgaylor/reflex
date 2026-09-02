import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { MacMessages } from "./messages-mac";

test("the Mac relay reads recent chats, threads and literal searches", async () => {
  const path = join(process.env.TMPDIR ?? "/tmp", `reflex-chat-${crypto.randomUUID()}.db`);
  const db = new Database(path, { create: true });
  db.run("create table chat (rowid integer primary key, guid text, display_name text)");
  db.run("create table handle (rowid integer primary key, id text)");
  db.run("create table chat_handle_join (chat_id integer, handle_id integer)");
  db.run("create table chat_message_join (chat_id integer, message_id integer)");
  db.run(`create table message (
    rowid integer primary key, guid text, text text, date integer, is_from_me integer,
    handle_id integer, service text, cache_has_attachments integer, associated_message_type integer
  )`);
  db.run("insert into chat values (1, 'iMessage;-;+15551234567', '')");
  db.run("insert into handle values (1, '+15551234567')");
  db.run("insert into chat_handle_join values (1, 1)");
  db.run("insert into message values (1, 'm1', 'Tuesday works', 800000000000000000, 0, 1, 'iMessage', 0, 0)");
  db.run("insert into message values (2, 'm2', 'Great, thanks', 800000001000000000, 1, null, 'iMessage', 0, 0)");
  db.run("insert into chat_message_join values (1, 1)");
  db.run("insert into chat_message_join values (1, 2)");
  db.close();

  const messages = new MacMessages(path);
  const recent = (await messages.execute({ id: "1", method: "recent", params: { limit: 5 } })) as Array<{ chat_guid: string; participants: string[] }>;
  expect(recent[0]).toMatchObject({ chat_guid: "iMessage;-;+15551234567", participants: ["+15551234567"] });
  const thread = (await messages.execute({ id: "2", method: "thread", params: { chat_id: recent[0]!.chat_guid, limit: 5 } })) as Array<{ text: string }>;
  expect(thread.map((m) => m.text)).toEqual(["Tuesday works", "Great, thanks"]);
  const found = (await messages.execute({ id: "3", method: "search", params: { query: "Tuesday", limit: 5 } })) as Array<{ text: string }>;
  expect(found.map((m) => m.text)).toEqual(["Tuesday works"]);
});
