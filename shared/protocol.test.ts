import { describe, expect, test } from "bun:test";
import { parseUpdate, stripUpdate } from "./protocol";
import { systemPrompt, DEFAULT_GUARDRAILS } from "./spec";

const block = (json: string) => "```reflex\n" + json + "\n```";

describe("parseUpdate", () => {
  test("reads jobs, memory and notifications", () => {
    const u = parseUpdate(
      "On it.\n" +
        block(
          JSON.stringify({
            jobs: [{ key: "comcast-bill", title: "Lower the Comcast bill", status: "working", note: "On hold" }],
            memory: { home_airport: "DEN" },
            notify: [{ kind: "done", text: "Booked the dentist for Tuesday" }],
          }),
        ),
    );
    expect(u.jobs).toEqual([{ key: "comcast-bill", title: "Lower the Comcast bill", status: "working", note: "On hold" }]);
    expect(u.memory).toEqual({ home_airport: "DEN" });
    expect(u.notify).toEqual([{ kind: "done", text: "Booked the dentist for Tuesday" }]);
  });

  test("an empty block and no block both yield nothing", () => {
    expect(parseUpdate(block("{}"))).toEqual({ jobs: [], memory: {}, notify: [] });
    expect(parseUpdate("just words")).toEqual({ jobs: [], memory: {}, notify: [] });
  });

  test("tolerates a sloppy agent", () => {
    const u = parseUpdate(
      block('{"jobs":[{"key":"Weird Key!","title":"x","status":"nope"},{"title":"no key"}],"memory":{"Home Airport":42},"notify":[{"text":"hi"},{}]}'),
    );
    expect(u.jobs).toEqual([{ key: "weird-key", title: "x", status: "working", note: "" }]);
    expect(u.memory).toEqual({ home_airport: "42" });
    expect(u.notify).toEqual([{ kind: "heads-up", text: "hi" }]);
  });

  test("malformed JSON is skipped, later block wins per job key", () => {
    const u = parseUpdate(
      block("{nope") +
        "\n" +
        block('{"jobs":[{"key":"aa","title":"A","status":"queued"}]}') +
        "\n" +
        block('{"jobs":[{"key":"aa","title":"A","status":"done","note":"finished"}]}'),
    );
    expect(u.jobs).toEqual([{ key: "aa", title: "A", status: "done", note: "finished" }]);
  });

  test("ignores other fences", () => {
    expect(parseUpdate("```json\n{\"jobs\":[]}\n```").jobs).toEqual([]);
  });
});

describe("stripUpdate", () => {
  test("removes the block and keeps the text", () => {
    expect(stripUpdate("Done.\n\n" + block("{}") + "\n")).toBe("Done.");
  });
});

describe("systemPrompt", () => {
  test("reflects guardrails and profile", () => {
    const p = systemPrompt({ name: "Jake", timezone: "America/Denver", about: "Lives in Denver.", guardrails: DEFAULT_GUARDRAILS });
    expect(p).toContain("Jake's personal assistant");
    expect(p).toContain("Lives in Denver.");
    expect(p).toContain("ask first, with the amount");
    const loose = systemPrompt({ name: "", timezone: "", about: "", guardrails: { askBeforeSpending: false, askBeforeSending: false, askBeforeCancelling: false } });
    expect(loose).toContain("You may spend money");
    expect(loose).toContain("has not told you about themselves");
  });
});
