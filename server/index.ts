/**
 * One process: the built page, the API, and the watchers that keep every
 * person's jobs board current while nobody has a tab open.
 */
import { buildApi } from "./api";
import { loadConfig } from "./config";
import { open as openDatabase, ready as databaseReady } from "./db";
import { Memory } from "./memory";
import * as store from "./store";
import { Hub, Watchers } from "./watcher";

const config = loadConfig(process.env);

if (!config.databaseUrl) {
  console.error("DATABASE_URL is not set. Reflex keeps each person's jobs, memory and sealed key in the database; refusing to start without it.");
  process.exit(1);
}
if (!config.secret) {
  console.error("REFLEX_SECRET is not set. It seals every person's Fountain key at rest; refusing to start without it.");
  process.exit(1);
}

const sql = await openDatabase(config.databaseUrl);
const hub = new Hub();
// clientFor / sendQueued are wired by buildApi, which owns the key store.
const watchers = new Watchers({ sql, hub, clientFor: async () => null, sendQueued: async () => undefined });

// Memory: each person's engram brain, behind the MCP bridge. A missing
// binary disables memory (the page says so) without taking the rest of
// Reflex down with it.
let memory: Memory | null = new Memory(sql, config.secret, config);
if (!(await memory.probe())) {
  memory.close();
  memory = null;
  console.warn(`memory: disabled (engram binary "${config.engramBin}" is not answering)`);
}
if (!config.publicUrl) console.warn("memory: REFLEX_PUBLIC_URL is not set; agents will not get memory tools");

const api = buildApi({ sql, secret: config.secret, hub, watchers, memory, publicUrl: config.publicUrl });
await watchers.startAll();

// Nightly consolidation: decay, promote, dedup, archive — what makes the
// memory a memory rather than a log.
if (memory) {
  const m = memory;
  setInterval(
    () => {
      void (async () => {
        const users = await store.usersWithAssistant(sql);
        await m.consolidateAll(users.filter((u) => u.memoryProvisionedAt).map((u) => u.id));
      })().catch((err) => console.warn(`memory: consolidation sweep failed: ${err instanceof Error ? err.message : String(err)}`));
    },
    24 * 60 * 60 * 1000,
  );
}

const server = Bun.serve({
  port: config.port,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return new Response("ok\n", { headers: { "content-type": "text/plain" } });
    if (url.pathname === "/readyz") {
      const ok = await databaseReady(sql);
      return new Response(ok ? "ready\n" : "database unavailable\n", { status: ok ? 200 : 503, headers: { "content-type": "text/plain" } });
    }
    if (url.pathname.startsWith("/api/")) {
      try {
        return await api(req, url);
      } catch (err) {
        console.error(`unhandled ${url.pathname}:`, err);
        return Response.json({ error: "unknown", message: "Something went wrong." }, { status: 500 });
      }
    }
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(`${config.distDir}${path}`);
    if (await file.exists()) {
      const immutable = path.startsWith("/assets/");
      return new Response(file, { headers: immutable ? { "cache-control": "public, max-age=31536000, immutable" } : { "cache-control": "no-cache" } });
    }
    return new Response(Bun.file(`${config.distDir}/index.html`), { headers: { "cache-control": "no-cache" } });
  },
});

console.log(`reflex on :${server.port} (dist=${config.distDir}, database connected, default fountain ${config.defaultFountain})`);
