import { describe, expect, test } from "bun:test";
import type { StreamEvent } from "../shared/api";
import { absorb, describeStep, presence, toTurnView } from "./fountain";
import { Hub, stripLive } from "./watcher";

describe("absorb", () => {
  test("text blocks concatenate, tool blocks become plain steps", () => {
    const acc = { text: "", steps: [] as string[] };
    const d1 = absorb(acc, { id: 1, kind: "output", ts: "", blocks: [{ kind: "text", body: "On it. " }] });
    const d2 = absorb(acc, { id: 2, kind: "output", ts: "", blocks: [{ kind: "tool_use", name: "Bash", summary: 'command=curl -sSL "https://www.comcast.com/deals"' }] });
    const d3 = absorb(acc, { id: 3, kind: "output", ts: "", blocks: [{ kind: "text", body: "Found the promo rate." }] });
    expect(d1.text).toBe("On it. ");
    expect(d2.step).toBe("Looked at comcast.com");
    expect(d3.text).toBe("Found the promo rate.");
    expect(acc.text).toBe("On it. Found the promo rate.");
    expect(acc.steps).toEqual(["Looked at comcast.com"]);
  });

  test("stage events and events without blocks are ignored", () => {
    const acc = { text: "", steps: [] as string[] };
    expect(absorb(acc, { id: 1, kind: "stage", ts: "", stage: "turn", state: "started" })).toEqual({});
    expect(absorb(acc, { id: 2, kind: "output", ts: "", data: "raw" })).toEqual({});
  });
});

describe("describeStep", () => {
  test("never shows a command line", () => {
    expect(describeStep({ kind: "tool_use", name: "Bash", summary: "command=rm -rf /tmp/x" })).toBe("Worked on its computer");
    expect(describeStep({ kind: "tool_use", name: "sms_send", summary: "to=+1555" })).toBe("Sent a text");
    expect(describeStep({ kind: "tool_use", name: "email_list", summary: "" })).toBe("Read email");
    expect(describeStep({ kind: "tool_use", name: "Write", summary: "~/reflex/memory.md" })).toBe("Took notes");
    expect(describeStep({ kind: "tool_use", name: "mystery", summary: "" })).toBeNull();
  });
});

describe("presence", () => {
  test("translates to the owner's words", () => {
    expect(presence(null)).toEqual({ state: "none", label: "Not set up yet", hired: false });
    const t = (state: string) => presence({ presence: { state, label: state } } as never);
    expect(t("working").label).toBe("Reflex is working");
    expect(t("starting").state).toBe("waking");
    expect(t("asleep").state).toBe("resting");
    expect(t("failed").state).toBe("trouble");
  });
});

describe("toTurnView", () => {
  test("strips the block and reads the channel off the prompt", () => {
    const v = toTurnView({
      id: "t1",
      number: 1,
      prompt: "[via sms] book the dentist",
      status: "completed",
      at: "2026-08-25T00:00:00Z",
      endedAt: null,
      text: 'Booked.\n```reflex\n{"jobs":[]}\n```',
      steps: [],
    });
    expect(v.via).toBe("sms");
    expect(v.reply).toBe("Booked.");
  });
});

describe("stripLive", () => {
  test("cuts a streaming chunk at the opening fence", () => {
    expect(stripLive("Done!\n```reflex\n{\"jo")).toBe("Done!\n");
    expect(stripLive("plain")).toBe("plain");
  });
});

describe("Hub", () => {
  test("fans out per user and unsubscribes cleanly", () => {
    const hub = new Hub();
    const got: StreamEvent[] = [];
    const off = hub.subscribe(1, (e) => got.push(e));
    hub.emit(1, { type: "jobs" });
    hub.emit(2, { type: "jobs" });
    off();
    hub.emit(1, { type: "jobs" });
    expect(got).toEqual([{ type: "jobs" }]);
  });
});
