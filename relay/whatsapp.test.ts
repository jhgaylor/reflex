import { expect, test } from "bun:test";
import { WhatsAppStore } from "./whatsapp";

const alice = "15551234567@s.whatsapp.net";
const group = "120363000000000001@g.us";

test("the WhatsApp store folds LIDs onto phone JIDs, keeps captions, applies edits and drops noise", () => {
  const store = new WhatsAppStore(":memory:");
  store.rememberContacts([{ id: alice, name: "Alice", lid: "111@lid" }, { id: "222@lid", phoneNumber: "15559876543@s.whatsapp.net", notify: "Bob" }]);
  store.rememberGroups([{ id: group, subject: "Family" }]);

  store.ingest({ key: { remoteJid: alice, fromMe: false, id: "A1" }, messageTimestamp: 1_700_000_000, pushName: "Alice", message: { conversation: "Tuesday works" } });
  store.ingest({ key: { remoteJid: alice, fromMe: true, id: "A2" }, messageTimestamp: 1_700_000_001, message: { extendedTextMessage: { text: "Great, thanks" } } });
  // the same person addressed by LID lands in the same chat
  store.ingest({ key: { remoteJid: "111@lid", remoteJidAlt: alice, fromMe: false, id: "A3" }, messageTimestamp: 1_700_000_002, pushName: "Alice", message: { imageMessage: { caption: "the menu" } } });
  // group message from Bob by LID with only a stored mapping
  store.ingest({ key: { remoteJid: group, participant: "222@lid", fromMe: false, id: "G1" }, messageTimestamp: 1_700_000_003, pushName: "Bob", message: { ephemeralMessage: { message: { audioMessage: { ptt: true } } } } });
  // noise: reactions, protocol messages, status posts
  store.ingest({ key: { remoteJid: alice, fromMe: false, id: "R1" }, messageTimestamp: 1_700_000_004, message: { reactionMessage: { text: "👍" } } });
  store.ingest({ key: { remoteJid: "status@broadcast", participant: alice, fromMe: false, id: "S1" }, messageTimestamp: 1_700_000_005, message: { conversation: "my status" } });
  store.ingest({ key: { remoteJid: alice, fromMe: false, id: "P1" }, messageTimestamp: 1_700_000_006, message: { protocolMessage: { type: 0 } } });
  // an edit rewrites the original by id
  store.ingest({ key: { remoteJid: alice, fromMe: false, id: "E1" }, messageTimestamp: 1_700_000_007, message: { protocolMessage: { key: { id: "A1" }, editedMessage: { conversation: "Tuesday at 3 works" } } } });

  const recent = store.recent(10) as Array<{ chat_id: string; chat_name: string; is_group: boolean; latest: { text: string; sender: string } }>;
  expect(recent.map((c) => [c.chat_id, c.chat_name, c.is_group])).toEqual([
    [group, "Family", true],
    [alice, "Alice", false],
  ]);
  expect(recent[0]!.latest).toMatchObject({ text: "[voice note]", sender: "Bob" });

  const thread = store.thread(alice, 10) as Array<{ text: string; sender: string; from_me: boolean; has_attachments: boolean }>;
  expect(thread.map((m) => [m.text, m.sender, m.from_me, m.has_attachments])).toEqual([
    ["Tuesday at 3 works", "Alice", false, false],
    ["Great, thanks", "me", true, false],
    ["the menu", "Alice", false, true],
  ]);
  expect((store.search("tuesday", 5) as Array<{ chat_name: string }>)[0]!.chat_name).toBe("Alice");
  expect(store.knowsChat(alice)).toBe(true);
  expect(store.knowsChat("15559876543@s.whatsapp.net")).toBe(true);
  expect(store.knowsChat("15550000000@s.whatsapp.net")).toBe(false);
});
