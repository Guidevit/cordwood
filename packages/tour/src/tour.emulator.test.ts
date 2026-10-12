// Runs against the Firestore emulator: `pnpm test` starts it.
import { randomUUID } from "node:crypto";
import { firestore as adminFirestore, tenantRef } from "@cordwood/firebase";
import { describe, expect, it } from "vitest";
import { createTours } from "./index.js";

if (!process.env.FIRESTORE_EMULATOR_HOST)
  throw new Error("the emulator is not running: use `pnpm test`");

const db = adminFirestore();
const tours = createTours({ firestore: db, tours: ["queue", "settings", "billing"] });
const id = () => randomUUID().replaceAll("-", "").slice(0, 20);
const who = () => ({ tenantId: id(), userId: id() });
const T0 = new Date("2026-10-01T12:00:00Z");

describe("the tours a person has seen", () => {
  it("are none before any ended", async () => {
    const { tenantId, userId } = who();
    expect(await tours.seen(tenantId, userId)).toEqual([]);
  });

  it("gain each tour as it ends, in the order of the list", async () => {
    const person = who();
    expect(await tours.end({ ...person, tour: "settings", how: "completed", now: T0 })).toEqual({
      status: "recorded",
      seen: ["settings"],
    });
    expect(await tours.end({ ...person, tour: "queue", how: "skipped", step: 2, now: T0 })).toEqual({
      status: "recorded",
      seen: ["queue", "settings"],
    });
    expect(await tours.seen(person.tenantId, person.userId)).toEqual(["queue", "settings"]);
    const stored = await tenantRef(db, person.tenantId).collection("tour_state").doc(person.userId).get();
    expect(stored.data()!.tours.queue).toMatchObject({ how: "skipped", step: 2 });
    expect(stored.data()!.tours.queue.at.toDate()).toEqual(T0);
    expect(stored.data()!.tours.settings).not.toHaveProperty("step");
  });

  it("keep the first ending: a later one changes nothing", async () => {
    const person = who();
    await tours.end({ ...person, tour: "queue", how: "skipped", step: 1, now: T0 });
    expect(await tours.end({ ...person, tour: "queue", how: "completed" })).toEqual({
      status: "already",
      seen: ["queue"],
    });
    const stored = await tenantRef(db, person.tenantId).collection("tour_state").doc(person.userId).get();
    expect(stored.data()!.tours.queue.how).toBe("skipped");
  });

  it("are each person's own", async () => {
    const one = who();
    const two = { tenantId: one.tenantId, userId: id() };
    await tours.end({ ...one, tour: "queue", how: "completed" });
    expect(await tours.seen(two.tenantId, two.userId)).toEqual([]);
  });

  it("record one ending for two requests at the same moment", async () => {
    const person = who();
    const both = await Promise.all([
      tours.end({ ...person, tour: "queue", how: "completed" }),
      tours.end({ ...person, tour: "queue", how: "skipped", step: 1 }),
    ]);
    expect(both.map((ended) => ended.status).sort()).toEqual(["already", "recorded"]);
  });

  it.each([
    ["a tour the app does not have", { tour: "nothing", how: "completed" }],
    ["a name every object has", { tour: "constructor", how: "completed" }],
    ["a tour that is no string", { tour: 7, how: "completed" }],
    ["another way of ending", { tour: "queue", how: "closed" }],
    ["a skip with no step", { tour: "queue", how: "skipped" }],
    ["a skip at step zero", { tour: "queue", how: "skipped", step: 0 }],
    ["a skip past the last step allowed", { tour: "queue", how: "skipped", step: 21 }],
    ["a skip at half a step", { tour: "queue", how: "skipped", step: 1.5 }],
  ])("refuse %s", async (_case, fields) => {
    const person = who();
    expect(await tours.end({ ...person, ...fields })).toEqual({ status: "invalid", seen: [] });
    expect(await tours.seen(person.tenantId, person.userId)).toEqual([]);
  });

  it("ignore a stored tour the app no longer has", async () => {
    const person = who();
    await tenantRef(db, person.tenantId)
      .collection("tour_state")
      .doc(person.userId)
      .set({ tours: { retired: { how: "completed" }, queue: { how: "completed" } } });
    expect(await tours.seen(person.tenantId, person.userId)).toEqual(["queue"]);
  });

  it("are forgotten with the person", async () => {
    const person = who();
    await tours.end({ ...person, tour: "queue", how: "completed" });
    await tours.forget(person.tenantId, person.userId);
    expect(await tours.seen(person.tenantId, person.userId)).toEqual([]);
  });
});

describe("the list of tours", () => {
  it("refuses a name that is not one", () => {
    expect(() => createTours({ firestore: db, tours: ["Queue Tour"] })).toThrow("lowercase");
  });

  it("allows a skip as far as the step it is told", async () => {
    const short = createTours({ firestore: db, tours: ["queue"], maxStep: 3 });
    const person = who();
    expect((await short.end({ ...person, tour: "queue", how: "skipped", step: 4 })).status).toBe("invalid");
    expect((await short.end({ ...person, tour: "queue", how: "skipped", step: 3 })).status).toBe("recorded");
  });
});
