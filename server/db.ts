/**
 * Opening the connection, which `store.ts` deliberately will not do.
 *
 * Kept apart so the store stays a set of functions over an injected `Sql` —
 * that is what lets its tests point at a scratch database, and what stops a
 * connection being opened as a side effect of an import.
 */
import { migrate, type Sql } from "./store";

/**
 * Bun's SQL client is itself a tagged-template function, which is the entire
 * interface `Sql` describes. The cast is to that narrower shape rather than
 * to `any`.
 */
export function connect(databaseUrl: string): Sql {
  return new Bun.SQL(databaseUrl) as unknown as Sql;
}

/**
 * Connect and bring the schema up to date, at boot, retrying while the
 * database is still coming up.
 *
 * The retry is not defensive programming for its own sake — it is the first
 * thing that actually happened. On the first rollout both replicas started
 * before `ward-pg` had finished its initdb, took `ERR_POSTGRES_CONNECTION_
 * REFUSED` from the very first statement of `migrate`, and crash-looped until
 * Postgres caught up. Kubernetes recovers from that on its own, but a
 * crash-loop is a bad way to say "waiting", and the same window opens on
 * every Postgres restart, failover and CNPG upgrade.
 *
 * It gives up eventually rather than waiting forever: a database that is
 * still refusing after this long is not slow, it is misconfigured, and a pod
 * that exits says so where a pod that hangs does not.
 *
 * Both replicas run this on every rollout, so every statement in `SCHEMA` has
 * to tolerate losing the race with the other pod — which is what `if not
 * exists` buys, and why there is no migration table to get wedged.
 */
export async function open(
  databaseUrl: string,
  // `open` is injectable so its retry can be tested without staging a real
  // outage — the alternative is a test that reimplements the loop and proves
  // only that the copy works.
  opts: { attempts?: number; delayMs?: number; connectImpl?: (url: string) => Sql } = {},
): Promise<Sql> {
  const attempts = opts.attempts ?? 30;
  const delayMs = opts.delayMs ?? 2000;
  const connectImpl = opts.connectImpl ?? connect;

  for (let attempt = 1; ; attempt++) {
    const sql = connectImpl(databaseUrl);
    try {
      await migrate(sql);
      if (attempt > 1) console.log(`database ready after ${attempt} attempts`);
      return sql;
    } catch (err) {
      if (attempt >= attempts) throw err;
      // A fresh client next time round: the failed one may be holding a
      // connection that will never open.
      console.warn(`database not ready (attempt ${attempt}/${attempts}): ${err instanceof Error ? err.message : String(err)}`);
      await Bun.sleep(delayMs);
    }
  }
}

/**
 * Whether the database is answering right now — what the readiness probe
 * asks.
 *
 * Deliberately separate from `/healthz`, which stays shallow. Readiness and
 * liveness want opposite things from a database outage: readiness should fail,
 * so the Service stops sending traffic to a pod that cannot serve; liveness
 * should *not*, because restarting a process whose dependency is down cures
 * nothing and turns a Postgres blip into a cluster-wide crash-loop.
 */
export async function ready(sql: Sql): Promise<boolean> {
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  }
}
