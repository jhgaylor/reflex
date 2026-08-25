/** What the process needs. Two things are fatal: the database and the secret that seals keys. */
export interface Config {
  databaseUrl: string | null;
  /** Derives the AES key that seals each person's Fountain key at rest. */
  secret: string | null;
  /** Where the page defaults to signing in; a person may sign in to another Fountain via "advanced". */
  defaultFountain: string;
  port: number;
  distDir: string;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const trim = (v: string | undefined) => v?.trim() || undefined;
  return {
    databaseUrl: trim(env.DATABASE_URL) ?? null,
    secret: trim(env.REFLEX_SECRET) ?? null,
    defaultFountain: (trim(env.FOUNTAIN_URL) ?? "https://fountain.inevitable.fyi").replace(/\/+$/, ""),
    port: Number(trim(env.PORT) ?? 8080) || 8080,
    distDir: trim(env.DIST_DIR) ?? "dist",
  };
}
