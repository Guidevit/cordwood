import { describe, expect, it } from "vitest";
import { daysBefore, engagement } from "./engagement.js";
import { defineEvents, eventKey, parseEvent, type EventDef } from "./events.js";

describe("the app's events", () => {
  it("lists its types in the order they were written", () => {
    const events = defineEvents({
      session_active: { subject: "user", keep: "daily" },
      first_import: { subject: "tenant", keep: "first" },
    });
    expect(events.types).toEqual(["session_active", "first_import"]);
  });

  it.each([
    ["no event", {}, "at least one event"],
    ["a name with a capital", { SessionActive: { subject: "user", keep: "daily" } }, "lower_snake_case"],
    [
      "a property that is a reserved field",
      { x: { subject: "user", keep: "daily", props: { day: "id" } } },
      "x.day is a reserved field",
    ],
    [
      "a key that is not a property",
      { x: { subject: "user", keep: "daily", key: ["feature"] } },
      "x.feature is not one of the event's properties",
    ],
  ])("refuses %s", (_case, table, message) => {
    expect(() => defineEvents(table as never)).toThrow(message);
  });
});

describe("an event against its definition", () => {
  const used: EventDef = {
    subject: "user",
    keep: "daily",
    props: { feature: ["search", "export"], source: "id", amount: "number" },
  };
  const good = {
    tenantId: "t1",
    userId: "u1",
    props: { feature: "search", source: "evt_1A", amount: 12.5 },
  };

  it("passes with every declared property, and only those reach the row", () => {
    expect(parseEvent(used, good)).toEqual({
      ok: true,
      tenantId: "t1",
      userId: "u1",
      props: { feature: "search", source: "evt_1A", amount: 12.5 },
    });
  });

  it.each([
    ["a word outside the list", { feature: "delete" }, "props.feature"],
    ["an e-mail where an id goes", { source: "ana@example.org" }, "props.source"],
    ["a sentence where an id goes", { source: "the Acme account" }, "props.source"],
    ["a number that is not finite", { amount: Infinity }, "props.amount"],
    ["a number sent as text", { amount: "12" }, "props.amount"],
    ["a field nobody declared", { name: "Ana" }, "props.name"],
    ["a declared property left out", { feature: undefined }, "props.feature"],
  ])("refuses %s, naming the field and not its value", (_case, change, path) => {
    expect(parseEvent(used, { ...good, props: { ...good.props, ...change } })).toEqual({
      ok: false,
      path,
    });
  });

  it("refuses a user event with no user, and a tenant event that names one", () => {
    const tenantEvent: EventDef = { subject: "tenant", keep: "first" };
    expect(parseEvent(used, { ...good, userId: undefined })).toEqual({ ok: false, path: "userId" });
    expect(parseEvent(tenantEvent, { tenantId: "t1", userId: "u1" })).toEqual({
      ok: false,
      path: "userId",
    });
    expect(parseEvent(tenantEvent, { tenantId: "t1" })).toEqual({
      ok: true,
      tenantId: "t1",
      userId: null,
      props: {},
    });
  });

  it.each(["", "a/b", "ana@example.org", undefined, 7])("refuses the tenant id %j", (tenantId) => {
    expect(parseEvent(used, { ...good, tenantId })).toEqual({ ok: false, path: "tenantId" });
  });
});

describe("an event's key", () => {
  const event = { tenantId: "t1", userId: "u1", props: { feature: "search" } };

  it("is the day and the person for a daily user event", () => {
    const def: EventDef = { subject: "user", keep: "daily" };
    expect(eventKey("session_active", def, event, "2026-10-11")).toBe(
      "session_active~2026-10-11~u1",
    );
  });

  it("takes the properties named as its key", () => {
    const def: EventDef = {
      subject: "user",
      keep: "daily",
      props: { feature: ["search"] },
      key: ["feature"],
    };
    expect(eventKey("feature_used", def, event, "2026-10-11")).toBe(
      "feature_used~2026-10-11~u1~search",
    );
  });

  it("has no day for a first event, and names the tenant when no person is named", () => {
    const def: EventDef = { subject: "tenant", keep: "first" };
    expect(eventKey("first_import", def, { ...event, userId: null }, "2026-10-11")).toBe(
      "first_import~t1",
    );
  });

  it("keeps apart two events whose parts would read the same joined", () => {
    const def: EventDef = { subject: "tenant", keep: "first", props: { ref: "id" }, key: ["ref"] };
    const one = eventKey("x", def, { tenantId: "a", userId: null, props: { ref: "b~c" } }, "d");
    const two = eventKey("x", def, { tenantId: "a~b", userId: null, props: { ref: "c" } }, "d");
    expect(one).not.toBe(two);
  });
});

describe("a day before another", () => {
  it("crosses months and years on the calendar", () => {
    expect(daysBefore("2026-03-01", 1)).toBe("2026-02-28");
    expect(daysBefore("2026-01-01", 1)).toBe("2025-12-31");
    expect(daysBefore("2026-10-11", 0)).toBe("2026-10-11");
  });
});

describe("engagement", () => {
  const TODAY = "2026-10-11";
  const days = [
    { day: "2026-10-11", users: ["ana", "bia"] },
    { day: "2026-10-10", users: ["ana"] },
    { day: "2026-10-05", users: ["ana", "caio"] },
    { day: "2026-10-04", users: ["dani"] },
    { day: "2026-09-12", users: ["edu"] },
    { day: "2026-09-11", users: ["fabi"] },
  ];

  it("counts people, not visits, in each window", () => {
    const result = engagement(days, TODAY);
    expect(result.dau).toBe(2);
    // The 7 days ending today start on 10-05: dani's 10-04 is outside.
    expect(result.wau).toBe(3);
    // The 30 days ending today start on 09-12: fabi's 09-11 is outside.
    expect(result.mau).toBe(5);
    expect(result.stickiness).toBe(2 / 5);
  });

  it("says how many days of the month each person came", () => {
    expect(engagement(days, TODAY).frequency).toEqual([
      { days: "1", users: 4 },
      { days: "2-4", users: 1 },
      { days: "5-14", users: 0 },
      { days: "15+", users: 0 },
    ]);
  });

  it("gives one point per day of the period, oldest first", () => {
    const { series } = engagement(days, TODAY, 3);
    expect(series).toEqual([
      { day: "2026-10-09", dau: 0, wau: 3, mau: 5 },
      { day: "2026-10-10", dau: 1, wau: 3, mau: 5 },
      { day: "2026-10-11", dau: 2, wau: 3, mau: 5 },
    ]);
  });

  it("counts a person once when a day arrives twice", () => {
    const twice = [
      { day: TODAY, users: ["ana"] },
      { day: TODAY, users: ["ana", "bia"] },
    ];
    expect(engagement(twice, TODAY).dau).toBe(2);
  });

  it("has no stickiness with nobody in the month", () => {
    expect(engagement([], TODAY)).toMatchObject({ dau: 0, wau: 0, mau: 0, stickiness: null });
  });
});
