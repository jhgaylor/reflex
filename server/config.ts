/** What the process needs. Two things are fatal: the database and the secret that seals keys. */
export interface Config {
  databaseUrl: string | null;
  /** Derives the AES key that seals each person's Fountain key at rest. */
  secret: string | null;
  /** Where the page defaults to signing in; a person may sign in to another Fountain via "advanced". */
  defaultFountain: string;
  port: number;
  distDir: string;
  /**
   * Where the agent's computer reaches this Reflex from outside (the memory
   * MCP endpoint). Unset means memory tools are not attached to the agent —
   * a sandbox cannot reach a Reflex it has no public address for.
   */
  publicUrl: string | null;
  /** The engram binary that serves each person's memory brain. */
  engramBin: string;
  /** Where the engram signing identity is materialized on disk. */
  engramHome: string;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const trim = (v: string | undefined) => v?.trim() || undefined;
  return {
    databaseUrl: trim(env.DATABASE_URL) ?? null,
    secret: trim(env.REFLEX_SECRET) ?? null,
    defaultFountain: (trim(env.FOUNTAIN_URL) ?? "https://fountain.inevitable.fyi").replace(/\/+$/, ""),
    port: Number(trim(env.PORT) ?? 8080) || 8080,
    distDir: trim(env.DIST_DIR) ?? "dist",
    publicUrl: (trim(env.REFLEX_PUBLIC_URL) ?? null)?.replace(/\/+$/, "") ?? null,
    engramBin: trim(env.ENGRAM_BIN) ?? "engram",
    engramHome: trim(env.ENGRAM_HOME) ?? "/tmp/reflex-engram",
  };
}
