import { expect, test } from "bun:test";
import { SignalStore } from "./signal";

test("the Signal store files incoming, phone-sent and group messages and answers the read commands", () => {
  const store = new SignalStore(":memory:");
  store.rememberContacts([{ number: "+15551234567", uuid: "aaaa-1", name: "Alice" }, { number: null, uuid: "bbbb-2", profile: { givenName: "Bob", familyName: "B" } }]);
  store.rememberGroups([{ id: "Z3JvdXA=", name: "Family" }]);

  store.ingest({ sourceNumber: "+15551234567", sourceUuid: "aaaa-1", sourceName: "Alice", timestamp: 1_700_000_000_000, dataMessage: { timestamp: 1_700_000_000_000, message: "Tuesday works" } });
  store.ingest({ syncMessage: { sentMessage: { destinationNumber: "+15551234567", timestamp: 1_700_000_001_000, message: "Great, thanks" } } });
  store.ingest({ sourceUuid: "bbbb-2", sourceName: "Bob", timestamp: 1_700_000_002_000, dataMessage: { timestamp: 1_700_000_002_000, message: null, attachments: [{ contentType: "image/jpeg" }], groupInfo: { groupId: "Z3JvdXA=", type: "DELIVER" } } });
  // reactions, receipts and group updates are noise
  store.ingest({ sourceNumber: "+15551234567", dataMessage: { timestamp: 1_700_000_003_000, reaction: { emoji: "👍" } } });
  store.ingest({ sourceNumber: "+15551234567", dataMessage: { timestamp: 1_700_000_004_000, groupInfo: { groupId: "Z3JvdXA=", type: "UPDATE" } } });
  // an edit replaces the text of the original
  store.ingest({ sourceNumber: "+15551234567", sourceUuid: "aaaa-1", editMessage: { targetSentTimestamp: 1_700_000_000_000, dataMessage: { timestamp: 1_700_000_005_000, message: "Tuesday at 3 works" } } });

  const recent = store.recent(10) as Array<{ chat_id: string; chat_name: string; is_group: boolean; latest: { text: string } }>;
  expect(recent.map((c) => [c.chat_id, c.chat_name, c.is_group])).toEqual([
    ["group:Z3JvdXA=", "Family", true],
    ["+15551234567", "Alice", false],
  ]);
  expect(recent[0]!.latest.text).toBe("[attachment]");

  const thread = store.thread("+15551234567", 10) as Array<{ text: string; sender: string; from_me: boolean }>;
  expect(thread.map((m) => [m.text, m.sender, m.from_me])).toEqual([
    ["Tuesday at 3 works", "Alice", false],
    ["Great, thanks", "me", true],
  ]);

  const found = store.search("tuesday", 10) as Array<{ text: string; chat_name: string }>;
  expect(found.map((m) => [m.text, m.chat_name])).toEqual([["Tuesday at 3 works", "Alice"]]);
  expect(store.knowsChat("+15551234567")).toBe(true);
  expect(store.knowsChat("bbbb-2")).toBe(true);
  expect(store.knowsChat("+15559999999")).toBe(false);

  store.recordOwn("+15551234567", 1_700_000_006_000, "See you then");
  expect((store.thread("+15551234567", 1) as Array<{ text: string }>)[0]!.text).toBe("See you then");
});
