/**
 * The store, against a real Postgres. Skips without TEST_DATABASE_URL; CI
 * always sets it, because the queries that keep one person's jobs from
 * showing up on another's page are exactly the ones worth running for real.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connect } from "./db";
import * as store from "./store";
import type { Sql } from "./store";

const url = process.env.TEST_DATABASE_URL;
const SECRET = "test-secret-with-enough-entropy-to-matter";

describe.skipIf(!url)("store", () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = connect(url!);
    for (const t of ["cursors", "outbox", "accounts", "message_devices", "message_pairings", "notifications", "memory", "jobs", "sessions", "users"]) {
      await sql(store.fixed(`drop table if exists ${t} cascade`));
    }
    await store.migrate(sql);
  });
  afterAll(async () => {
    await (sql as unknown as { end?: () => Promise<void> }).end?.();
  });

  test("sign-in upserts the person and keeps the newest key sealed", async () => {
    const a = await store.upsertUser(sql, SECRET, { email: "Jake@Example.com", fountainUrl: "https://f.example", apiKey: "ftn_one" });
    const b = await store.upsertUser(sql, SECRET, { email: "jake@example.com", fountainUrl: "https://f.example", apiKey: "ftn_two" });
    expect(b.id).toBe(a.id);
    expect(await store.fountainKey(sql, SECRET, a.id)).toBe("ftn_two");
    expect(await store.fountainKey(sql, "wrong", a.id)).toBeNull();
    const rows = await sql`select fountain_key from users where id = ${a.id}`;
    expect(String(rows[0]!.fountain_key)).not.toContain("ftn_two");
  });

  test("sessions resolve to their person and nobody else", async () => {
    const u = await store.upsertUser(sql, SECRET, { email: "s@example.com", fountainUrl: "https://f.example", apiKey: "k" });
    await store.createSession(sql, u.id, "tok-1");
    expect((await store.userForSession(sql, "tok-1"))?.id).toBe(u.id);
    expect(await store.userForSession(sql, "tok-2")).toBeNull();
    await store.deleteSession(sql, "tok-1");
    expect(await store.userForSession(sql, "tok-1")).toBeNull();
  });

  test("jobs and memory are per person", async () => {
    const a = await store.upsertUser(sql, SECRET, { email: "a@example.com", fountainUrl: "https://f.example", apiKey: "k" });
    const b = await store.upsertUser(sql, SECRET, { email: "b@example.com", fountainUrl: "https://f.example", apiKey: "k" });
    await store.upsertJob(sql, a.id, { key: "dentist", title: "Find a dentist", status: "working", note: "calling" });
    await store.upsertJob(sql, a.id, { key: "dentist", title: "Find a dentist", status: "done", note: "Tuesday 2pm" });
    await store.setMemory(sql, a.id, "home_airport", "DEN");
    expect((await store.listJobs(sql, a.id)).map((j) => [j.key, j.status, j.note])).toEqual([["dentist", "done", "Tuesday 2pm"]]);
    expect(await store.listJobs(sql, b.id)).toEqual([]);
    expect((await store.listMemory(sql, a.id)).map((m) => m.value)).toEqual(["DEN"]);
    expect(await store.listMemory(sql, b.id)).toEqual([]);
    await store.setMemory(sql, a.id, "home_airport", "");
    expect(await store.listMemory(sql, a.id)).toEqual([]);
    expect(await store.setJobStatus(sql, b.id, "dentist", "dropped")).toBeNull();
  });

  test("outbox is FIFO and the cursor only moves forward", async () => {
    const u = await store.upsertUser(sql, SECRET, { email: "q@example.com", fountainUrl: "https://f.example", apiKey: "k" });
    await store.enqueue(sql, u.id, "first");
    await store.enqueue(sql, u.id, "second");
    expect(await store.queued(sql, u.id)).toBe(2);
    const n = await store.nextQueued(sql, u.id);
    expect(n?.text).toBe("first");
    await store.dequeue(sql, n!.id);
    expect((await store.nextQueued(sql, u.id))?.text).toBe("second");
    await store.saveCursor(sql, u.id, 50);
    await store.saveCursor(sql, u.id, 20);
    expect(await store.cursor(sql, u.id)).toBe(50);
  });

  test("notifications list newest first and mark read", async () => {
    const u = await store.upsertUser(sql, SECRET, { email: "n@example.com", fountainUrl: "https://f.example", apiKey: "k" });
    await store.addNotification(sql, u.id, "done", "Booked");
    await store.addNotification(sql, u.id, "needs-you", "Pick a time");
    const list = await store.listNotifications(sql, u.id);
    expect(list.map((n) => n.text)).toEqual(["Pick a time", "Booked"]);
    expect(list.every((n) => !n.read)).toBe(true);
    await store.markNotificationsRead(sql, u.id);
    expect((await store.listNotifications(sql, u.id)).every((n) => n.read)).toBe(true);
  });

  test("a Messages pairing is one-use and device credentials are digest-only", async () => {
    const u = await store.upsertUser(sql, SECRET, { email: "mac@example.com", fountainUrl: "https://f.example", apiKey: "k" });
    const pairing = await store.createMessagePairing(sql, u.id);
    const claimed = await store.claimMessagePairing(sql, pairing.code.toLowerCase(), "Desk Mac");
    expect(claimed?.user.id).toBe(u.id);
    expect(claimed?.device).toMatchObject({ name: "Desk Mac", kind: "imessage" });
    const signal = await store.claimMessagePairing(sql, (await store.createMessagePairing(sql, u.id, "signal")).code, "Signal box");
    expect(signal?.device.kind).toBe("signal");
    expect((await store.listMessageDevices(sql, u.id, "signal")).map((d) => d.id)).toEqual([signal!.device.id]);
    expect((await store.listMessageDevices(sql, u.id)).length).toBe(2);
    expect(await store.claimMessagePairing(sql, pairing.code, "Other Mac")).toBeNull();
    expect((await store.messageDeviceByToken(sql, claimed!.token))?.device.id).toBe(claimed?.device.id);
    const rows = await sql`select token_digest from message_devices where id = ${claimed!.device.id}`;
    expect(String(rows[0]!.token_digest)).not.toContain(claimed!.token);
    await store.touchMessageDevice(sql, claimed!.device.id);
    expect((await store.listMessageDevices(sql, u.id, "imessage"))[0]!.lastSeenAt).not.toBeNull();
    await store.revokeMessageDevice(sql, u.id, claimed!.device.id);
    expect(await store.messageDeviceByToken(sql, claimed!.token)).toBeNull();
  });
});
