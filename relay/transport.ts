/**
 * What every Reflex relay shares: a one-time pairing that yields a device
 * token, a saved config under ~/.config/reflex, and the long-poll loop that
 * fetches commands and posts results. Relays only make outbound HTTPS
 * requests to the Reflex server; nothing listens on the owner's network.
 */
import { chmod, mkdir } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";

export type RelayKind = "imessage" | "signal";

export interface RelayConfig {
  server: string;
  token: string;
  deviceId: string;
}

export interface Command {
  id: string;
  method: "recent" | "thread" | "search" | "send";
  params: Record<string, unknown>;
}

export interface RelayArgs {
  server?: string;
  code?: string;
  name?: string;
  config?: string;
  database?: string;
  account?: string;
  link?: boolean;
  help?: boolean;
}

/** `--key value` options plus a few flags; anything else is a usage error. */
export function parseArgs(argv: string[], usage: (error?: string) => never): RelayArgs {
  const out: RelayArgs = {};
  const valued = new Set(["server", "code", "name", "config", "database", "account"]);
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i] ?? "";
    const name = key.replace(/^--/, "") as keyof RelayArgs;
    if (key === "--help" || key === "-h") usage();
    else if (key === "--link") out.link = true;
    else if (key.startsWith("--") && valued.has(name) && argv[i + 1] !== undefined) {
      (out as Record<string, string>)[name] = argv[i + 1]!;
      i += 1;
    } else usage(`Unknown or incomplete option: ${key}`);
  }
  return out;
}

export function defaultConfigPath(kind: RelayKind): string {
  return join(homedir(), ".config", "reflex", `${kind === "imessage" ? "messages" : kind}-relay.json`);
}

/** Pairs when --server and --code are given, otherwise loads the saved pairing. */
export async function loadPairing(kind: RelayKind, args: RelayArgs, configPath: string, usage: (error?: string) => never): Promise<RelayConfig> {
  let config = await readConfig(configPath);
  if (args.server && args.code) {
    const name = (args.name ?? hostname()).trim().slice(0, 80);
    config = await pair(kind, args.server, args.code, name, usage);
    await saveConfig(configPath, config);
    console.log(`Paired ${name} with Reflex. The device token is stored at ${configPath}.`);
  }
  if (!config) usage("No saved pairing. Pass --server and --code once.");
  return config;
}

/** Long-polls for commands forever, running each one through `execute`. */
export async function serve(kind: RelayKind, config: RelayConfig, execute: (command: Command) => Promise<unknown>, usage: (error?: string) => never): Promise<never> {
  const base = `${config.server}/api/relay/${kind}`;
  console.log(`Connected to ${config.server}. Leave this process running; Ctrl-C stops it.`);
  let delay = 1000;
  for (;;) {
    try {
      const res = await fetch(`${base}/poll`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.token}`, accept: "application/json" },
        signal: AbortSignal.timeout(40_000),
      });
      if (res.status === 204) {
        delay = 1000;
        continue;
      }
      if (res.status === 401) usage("This relay was disconnected from Reflex. Pair it again from the Connections page.");
      if (!res.ok) throw new Error(`poll returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const command = (await res.json()) as Command;
      let result: unknown;
      let error: string | undefined;
      try {
        result = await execute(command);
      } catch (err) {
        error = errorText(err);
      }
      const done = await fetch(`${base}/result`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
        body: JSON.stringify({ id: command.id, result, error }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!done.ok && done.status !== 404) throw new Error(`result returned ${done.status}`);
      delay = 1000;
    } catch (err) {
      console.error(`${new Date().toISOString()} ${errorText(err)}; retrying in ${Math.round(delay / 1000)}s`);
      await Bun.sleep(delay);
      delay = Math.min(delay * 2, 15_000);
    }
  }
}

async function pair(kind: RelayKind, server: string, code: string, name: string, usage: (error?: string) => never): Promise<RelayConfig> {
  const base = server.trim().replace(/\/+$/, "");
  if (!/^https:\/\//.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) usage("--server must use HTTPS (HTTP is allowed only for localhost).");
  const res = await fetch(`${base}/api/relay/${kind}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ code: code.trim(), name }),
  });
  const body = (await res.json().catch(() => ({}))) as Partial<RelayConfig> & { message?: string };
  if (!res.ok || !body.token || !body.deviceId) usage(body.message ?? `Pairing failed (${res.status}).`);
  return { server: base, token: body.token, deviceId: body.deviceId };
}

async function readConfig(path: string): Promise<RelayConfig | null> {
  try {
    const parsed = JSON.parse(await Bun.file(path).text()) as RelayConfig;
    return parsed.server && parsed.token && parsed.deviceId ? parsed : null;
  } catch {
    return null;
  }
}

async function saveConfig(path: string, config: RelayConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await Bun.write(path, JSON.stringify(config, null, 2) + "\n");
  await chmod(path, 0o600);
}

export function required(value: unknown, name: string): string {
  const s = typeof value === "string" ? value.trim() : "";
  if (!s) throw new Error(`${name} is required`);
  return s;
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function makeUsage(text: string): (error?: string) => never {
  return (error?: string) => {
    if (error) console.error(error);
    console.error(text);
    process.exit(error ? 1 : 0);
  };
}
