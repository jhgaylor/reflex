#!/usr/bin/env bun
/**
 * A stub `engram mcp serve` for the bridge tests: the same newline-delimited
 * JSON-RPC over stdio, no Postgres. Answers initialize and tools/list with
 * fixed cards, echoes anything else back under its id (so a test can see
 * which request an answer belongs to), and exits on `stub/exit`.
 */
const decoder = new TextDecoder();

function reply(msg: Record<string, unknown>): void {
  console.log(JSON.stringify({ jsonrpc: "2.0", ...msg }));
}

let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += decoder.decode(chunk, { stream: true });
  let nl: number;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg: { id?: number | string; method?: string; params?: unknown };
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.method === "stub/exit") process.exit(0);
    if (msg.id === undefined || msg.id === null) continue; // a notification
    if (msg.method === "initialize") {
      reply({ id: msg.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "engram-stub", version: "0" } } });
    } else if (msg.method === "tools/list") {
      reply({ id: msg.id, result: { tools: [{ name: "engram_search", inputSchema: { type: "object" } }] } });
    } else {
      // Deliberately slow enough that two in-flight calls overlap.
      await Bun.sleep(20);
      reply({ id: msg.id, result: { method: msg.method, params: msg.params ?? null } });
    }
  }
}
