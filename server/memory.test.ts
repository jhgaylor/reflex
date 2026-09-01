/**
 * The bridge, against a stub engram: same stdio framing, none of the
 * Postgres. What matters is what the sandbox-side MCP client observes —
 * initialize answered per session, ids returned untouched, notifications
 * absorbed, garbage refused — and that ids are remapped underneath so two
 * client sessions using the same id cannot collide on one child.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Memory, parseEntries } from "./memory";
import type { Sql } from "./store";

const STUB = `${import.meta.dir}/../mock/engram-stub.ts`;

// The only app-database traffic the bridge is allowed is the keystore
// restore (engram_files); answer it empty and refuse everything else.
const sqlKeystoreOnly: Sql = (async (strings: TemplateStringsArray) => {
  if (strings.join("?").includes("engram_files")) return [];
  throw new Error(`the bridge must not touch the app database: ${strings.join("?")}`);
}) as Sql;

function bridge(): Memory {
  return new Memory(sqlKeystoreOnly, "test-secret", {
    databaseUrl: "postgres://nobody@127.0.0.1:1/reflex_app",
    engramBin: STUB,
    engramHome: "/tmp/reflex-engram-test",
  });
}

let m: Memory;
beforeAll(() => {
  m = bridge();
});
afterAll(() => m.close());

describe("the memory bridge", () => {
  test("initialize is answered from the child's handshake, with the client's id", async () => {
    const res = await m.handleMcp(1, { jsonrpc: "2.0", id: "init-9", method: "initialize", params: {} });
    expect(res.status).toBe(200);
    const body = res.body as { id: string; result: { serverInfo: { name: string } } };
    expect(body.id).toBe("init-9");
    expect(body.result.serverInfo.name).toBe("engram-stub");
  });

  test("notifications are absorbed with a 202", async () => {
    const res = await m.handleMcp(1, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.status).toBe(202);
    expect(res.body).toBeNull();
  });

  test("requests come back under the caller's id, even when sessions collide", async () => {
    const [a, b] = await Promise.all([
      m.handleMcp(1, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "engram_search", arguments: { query: "alpha" } } }),
      m.handleMcp(1, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "engram_search", arguments: { query: "beta" } } }),
    ]);
    const bodyA = a.body as { id: number; result: { params: { arguments: { query: string } } } };
    const bodyB = b.body as { id: number; result: { params: { arguments: { query: string } } } };
    expect(bodyA.id).toBe(1);
    expect(bodyB.id).toBe(1);
    expect(bodyA.result.params.arguments.query).toBe("alpha");
    expect(bodyB.result.params.arguments.query).toBe("beta");
  });

  test("a batch answers each request and drops the notifications", async () => {
    const res = await m.handleMcp(1, [
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 7, method: "tools/list" },
    ]);
    expect(res.status).toBe(200);
    const arr = res.body as Array<{ id: number }>;
    expect(arr).toHaveLength(1);
    expect(arr[0]!.id).toBe(7);
  });

  test("garbage is a 400, not a crash", async () => {
    expect((await m.handleMcp(1, null)).status).toBe(400);
    expect((await m.handleMcp(1, { no: "method" })).status).toBe(400);
  });

  test("a dead child is replaced on the next call", async () => {
    await m.handleMcp(2, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    await m.handleMcp(2, { jsonrpc: "2.0", id: 2, method: "stub/exit" }).catch(() => undefined);
    await Bun.sleep(100);
    const res = await m.handleMcp(2, { jsonrpc: "2.0", id: 3, method: "tools/list" });
    expect(res.status).toBe(200);
    expect((res.body as { result: unknown }).result).toBeDefined();
  });
});

describe("parseEntries", () => {
  test("takes a bare array and common field spellings", () => {
    const rows = parseEntries(
      JSON.stringify([
        { id: "a", content: "home airport: DEN", category: "context", source: "import", created_at: "2026-01-01T00:00:00Z", tags: ["reflex-import"], strength: 0.8 },
        { entry_id: "b", summary: "prefers aisle seats", kind: "insight", occurred_at: "2026-02-01T00:00:00Z" },
        { nothing: "usable" },
      ]),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: "a", content: "home airport: DEN", category: "context", strength: 0.8 });
    expect(rows[1]).toMatchObject({ id: "b", content: "prefers aisle seats", category: "insight", at: "2026-02-01T00:00:00Z" });
  });

  test("takes wrapped shapes and refuses garbage", () => {
    expect(parseEntries(JSON.stringify({ results: [{ id: "x", content: "hi" }] }))).toHaveLength(1);
    expect(parseEntries(JSON.stringify({ entries: [{ id: "x", content: "hi" }] }))).toHaveLength(1);
    expect(parseEntries("not json")).toEqual([]);
    expect(parseEntries(JSON.stringify({ ok: true }))).toEqual([]);
  });
});
