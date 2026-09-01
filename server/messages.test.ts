import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_GUARDRAILS, type Profile } from "../shared/spec";
import { MessagesBridge, type RelayCommand } from "./messages";

const profile: Profile = { name: "Jake", timezone: "UTC", about: "", guardrails: DEFAULT_GUARDRAILS };
let bridge = new MessagesBridge();

afterEach(() => {
  bridge.close();
  bridge = new MessagesBridge();
});

describe("Messages MCP bridge", () => {
  test("advertises the four tools", async () => {
    const init = await bridge.handleMcp(profile, 1, { jsonrpc: "2.0", id: "i", method: "initialize", params: {} });
    expect((init.body as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe("reflex-messages");
    const listed = await bridge.handleMcp(profile, 1, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = (listed.body as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
    expect(names).toEqual(["messages_recent", "messages_thread", "messages_search", "messages_send"]);
  });

  test("routes a tool call to the owner's polling Mac", async () => {
    const poll = bridge.poll(7, "mac-1");
    const call = bridge.handleMcp(profile, 7, {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "messages_search", arguments: { query: "dentist", limit: 5 } },
    });
    const command = (await poll) as RelayCommand;
    expect(command).toMatchObject({ method: "search", params: { query: "dentist", limit: 5 } });
    expect(bridge.complete(8, command.id, [{ text: "wrong owner" }])).toBe(false);
    expect(bridge.complete(7, command.id, [{ text: "Tuesday works" }])).toBe(true);
    const answer = await call;
    const text = (answer.body as { result: { content: Array<{ text: string }> } }).result.content[0]!.text;
    expect(text).toContain("Tuesday works");
  });

  test("requires explicit confirmation when the sending guardrail is on", async () => {
    const blocked = await bridge.handleMcp(profile, 1, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "messages_send", arguments: { chat_guid: "iMessage;-;+15551234567", text: "Hello" } },
    });
    const result = (blocked.body as { result: { isError?: boolean; content: Array<{ text: string }> } }).result;
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("must approve");

    const poll = bridge.poll(1, "mac-1");
    const allowed = bridge.handleMcp(profile, 1, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "messages_send", arguments: { chat_guid: "iMessage;-;+15551234567", text: "Hello", confirmed: true } },
    });
    const command = (await poll) as RelayCommand;
    expect(command.method).toBe("send");
    bridge.complete(1, command.id, { sent: true });
    expect((await allowed).status).toBe(200);
  });
});
