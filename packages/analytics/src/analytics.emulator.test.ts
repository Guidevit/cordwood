// Runs against the Firestore emulator: `pnpm test` starts it.
import { randomUUID } from "node:crypto";
import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { describe, expect, it } from "vitest";
import { createAnalytics, defineEvents } from "./index.js";

if (!process.env.FIRESTORE_EMULATOR_HOST)
  throw new Error("the Firestore emulator is not running: use `pnpm test`");

const db = getFirestore(getApps()[0] ?? initializeApp());
const events = defineEvents({
  session_active: { subject: "user", keep: "daily" },
  feature_used: {
    subject: "user",
    keep: "daily",
    props: { feature: ["search", "export"] },
    key: ["feature"],
  },
  first_import: { subject: "tenant", keep: "first" },
  plan_changed: {
    subject: "tenant",
    keep: "first",
    props: { source: "id", monthly: "number" },
    key: ["source"],
  },
});

/** Its own collection per test: nothing another test wrote is ever counted. */
function fresh() {
  const lines: string[] = [];
  const collection = `events_${randomUUID().replaceAll("-", "")}`;
  const analytics = createAnalytics({
    firestore: db,
    events,
    timeZone: "America/Sao_Paulo",
    collection,
    log: (line) => lines.push(line),
  });
  return { analytics, lines, rows: () => db.collection(collection).get() };
}

describe("the day an event falls on", () => {
  it("is the configured zone's, not UTC's", () => {
    const { analytics } = fresh();
    // 01:30 UTC on the 12th is 22:30 on the 11th in São Paulo.
    expect(analytics.dayOf(new Date("2026-10-12T01:30:00Z"))).toBe("2026-10-11");
    expect(analytics.dayOf(new Date("2026-10-12T03:00:00Z"))).toBe("2026-10-12");
  });

  it("refuses a time zone the runtime does not know, at start-up", () => {
    expect(() =>
      createAnalytics({ firestore: db, events, timeZone: "Mars/Olympus" }),
    ).toThrow();
  });
});

describe("a daily event", () => {
  it("keeps one row per person per day and tallies the repeats", async () => {
    const { analytics, rows } = fresh();
    const input = { tenantId: "t1", userId: "ana" };
    expect(await analytics.record("session_active", input)).toBe("recorded");
    expect(await analytics.record("session_active", input)).toBe("recorded");
    expect(await analytics.record("session_active", { tenantId: "t1", userId: "bia" })).toBe(
      "recorded",
    );
    const found = await rows();
    expect(found.size).toBe(2);
    const ana = found.docs.find((d) => d.get("userId") === "ana")!;
    expect(ana.data()).toMatchObject({
      type: "session_active",
      tenantId: "t1",
      userId: "ana",
      day: analytics.dayOf(),
      count: 2,
    });
  });

  it("can make the row exist without counting a visit", async () => {
    const { analytics, rows } = fresh();
    const input = { tenantId: "t1", userId: "ana" };
    await analytics.record("session_active", input, { counts: false });
    expect((await rows()).docs[0]!.get("count")).toBe(0);
    await analytics.record("session_active", input);
    await analytics.record("session_active", input, { counts: false });
    expect((await rows()).docs[0]!.get("count")).toBe(1);
  });

  it("keeps a row per value of its key", async () => {
    const { analytics, rows } = fresh();
    const base = { tenantId: "t1", userId: "ana" };
    await analytics.record("feature_used", { ...base, props: { feature: "search" } });
    await analytics.record("feature_used", { ...base, props: { feature: "search" } });
    await analytics.record("feature_used", { ...base, props: { feature: "export" } });
    const found = (await rows()).docs.map((d) => [d.get("feature"), d.get("count")]).sort();
    expect(found).toEqual([
      ["export", 1],
      ["search", 2],
    ]);
  });
});

describe("a first event", () => {
  it("is created once and keeps its instant", async () => {
    const { analytics, rows } = fresh();
    const first = new Date("2026-09-01T12:00:00Z");
    expect(await analytics.record("first_import", { tenantId: "t1" }, { at: first })).toBe(
      "recorded",
    );
    expect(await analytics.record("first_import", { tenantId: "t1" })).toBe("already_recorded");
    const found = await rows();
    expect(found.size).toBe(1);
    expect(found.docs[0]!.get("at").toDate()).toEqual(first);
    // The day is the instant's own, in the zone: a backfill lands where the thing happened.
    expect(found.docs[0]!.get("day")).toBe("2026-09-01");
    expect(found.docs[0]!.get("userId")).toBeNull();
  });

  it("counts once per value of its key, so a redelivery lands on the same row", async () => {
    const { analytics, rows } = fresh();
    const change = (source: string) =>
      analytics.record("plan_changed", { tenantId: "t1", props: { source, monthly: 49 } });
    expect(await change("evt_1")).toBe("recorded");
    expect(await change("evt_1")).toBe("already_recorded");
    expect(await change("evt_2")).toBe("recorded");
    expect((await rows()).size).toBe(2);
  });
});

describe("an event the table refuses", () => {
  it("is not written, and the log names the field, never the value", async () => {
    const { analytics, lines, rows } = fresh();
    expect(
      await analytics.record("plan_changed", {
        tenantId: "t1",
        props: { source: "ana@example.org", monthly: 49 },
      }),
    ).toBe("invalid");
    expect(
      await analytics.record("session_active", { tenantId: "t1" } as never),
    ).toBe("invalid");
    expect(await analytics.record("never_defined" as never, { tenantId: "t1" } as never)).toBe(
      "invalid",
    );
    expect((await rows()).size).toBe(0);
    expect(lines).toEqual([
      "[analytics] plan_changed refused by its definition: props.source",
      "[analytics] session_active refused by its definition: userId",
      "[analytics] event refused: unknown type",
    ]);
    expect(lines.join()).not.toContain("ana@example.org");
  });
});

describe("recording never costs the act underneath", () => {
  it("answers `failed` and logs the code when Firestore refuses the write", async () => {
    const lines: string[] = [];
    const broken = {
      collection: () => ({
        doc: () => ({
          set: () => Promise.reject(Object.assign(new Error("ana@example.org"), { code: 14 })),
        }),
      }),
    };
    const analytics = createAnalytics({
      firestore: broken as never,
      events,
      timeZone: "UTC",
      log: (line) => lines.push(line),
    });
    expect(await analytics.record("session_active", { tenantId: "t1", userId: "ana" })).toBe(
      "failed",
    );
    expect(lines).toEqual(["[analytics] session_active not recorded: 14"]);
  });
});

describe("a first event inside a transaction", () => {
  it("commits with the caller's write, and is false once its row exists", async () => {
    const { analytics, rows } = fresh();
    const other = db.collection(`other_${randomUUID().replaceAll("-", "")}`).doc("x");
    const input = { tenantId: "t1", props: { source: "evt_9", monthly: 99 } };
    const once = await db.runTransaction(async (tx) => {
      const written = await analytics.recordInTransaction(tx, "plan_changed", input);
      tx.set(other, { n: 1 });
      return written;
    });
    const again = await db.runTransaction((tx) =>
      analytics.recordInTransaction(tx, "plan_changed", input),
    );
    expect([once, again]).toEqual([true, false]);
    expect((await rows()).size).toBe(1);
    expect((await other.get()).data()).toEqual({ n: 1 });
  });

  it("is not written when the transaction fails", async () => {
    const { analytics, rows } = fresh();
    await expect(
      db.runTransaction(async (tx) => {
        await analytics.recordInTransaction(tx, "first_import", { tenantId: "t1" });
        throw new Error("the caller's write failed");
      }),
    ).rejects.toThrow("the caller's write failed");
    expect((await rows()).size).toBe(0);
  });

  it("throws for an event the table refuses, and for one that tallies repeats", async () => {
    const { analytics } = fresh();
    await expect(
      db.runTransaction((tx) =>
        analytics.recordInTransaction(tx, "first_import", { tenantId: "a/b" }),
      ),
    ).rejects.toThrow("refused by its definition: tenantId");
    await expect(
      db.runTransaction((tx) =>
        analytics.recordInTransaction(tx, "session_active", { tenantId: "t1", userId: "ana" }),
      ),
    ).rejects.toThrow("tallies repeats");
  });
});

describe("reading the log back", () => {
  const at = (day: string) => new Date(`${day}T15:00:00Z`);

  async function seeded() {
    const made = fresh();
    const visit = (userId: string, day: string) =>
      made.analytics.record("session_active", { tenantId: "t1", userId }, { at: at(day) });
    await Promise.all([
      visit("ana", "2026-10-11"),
      visit("bia", "2026-10-11"),
      visit("ana", "2026-10-10"),
      visit("caio", "2026-10-05"),
      visit("dani", "2026-10-04"),
      visit("edu", "2026-09-12"),
      visit("fabi", "2026-09-11"),
      // Another event type on the same days is never counted as a visit.
      made.analytics.record(
        "feature_used",
        { tenantId: "t1", userId: "zeca", props: { feature: "search" } },
        { at: at("2026-10-11") },
      ),
    ]);
    return made.analytics;
  }

  it("lists who was active on each day of a range, oldest first", async () => {
    const analytics = await seeded();
    const days = await analytics.activeDays("session_active", {
      from: "2026-10-05",
      to: "2026-10-11",
    });
    expect(days.map((d) => [d.day, [...d.users].sort()])).toEqual([
      ["2026-10-05", ["caio"]],
      ["2026-10-10", ["ana"]],
      ["2026-10-11", ["ana", "bia"]],
    ]);
  });

  it("computes engagement as of a day", async () => {
    const analytics = await seeded();
    const result = await analytics.engagement("session_active", { today: "2026-10-11", period: 2 });
    expect(result).toMatchObject({ dau: 2, wau: 3, mau: 5, stickiness: 2 / 5 });
    // The older point's own 30-day window reaches back to 09-11, so fabi counts there.
    expect(result.series).toEqual([
      { day: "2026-10-10", dau: 1, wau: 3, mau: 5 },
      { day: "2026-10-11", dau: 2, wau: 3, mau: 5 },
    ]);
  });

  it("refuses to read active users from an event that is not daily and per user", async () => {
    const { analytics } = fresh();
    await expect(
      analytics.activeDays("first_import", { from: "2026-10-01", to: "2026-10-11" }),
    ).rejects.toThrow("not a daily user event");
  });
});
