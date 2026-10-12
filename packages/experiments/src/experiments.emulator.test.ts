// Runs against the Firestore emulator: `pnpm test` starts it.
import { randomUUID } from "node:crypto";
import { firestore as adminFirestore } from "@cordwood/firebase";
import type { Firestore } from "firebase-admin/firestore";
import { describe, expect, it } from "vitest";
import { armOf, createExperiments, defineExperiments } from "./index.js";

if (!process.env.FIRESTORE_EMULATOR_HOST)
  throw new Error("the emulator is not running: use `pnpm test`");

const db = adminFirestore();
const T0 = new Date("2026-10-01T12:00:00Z");
const ARMS = { control: 1, annual: 1 };

/** An experiment nobody else counted in: ids are what separates one test's events from another's. */
function experimentOf(extra: { perArm?: number } = {}) {
  const id = `t${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const definitions = defineExperiments({
    [id]: { arms: ARMS, goals: ["signup", "paid"], ...extra },
  });
  const lines: string[] = [];
  const experiments = createExperiments({
    firestore: db,
    experiments: definitions,
    log: (line) => lines.push(line),
  });
  return { id, experiments, lines };
}

/** `n` units that fall in `arm`. */
function unitsIn(id: string, arm: string, n: number): string[] {
  const found: string[] = [];
  for (let i = 0; found.length < n; i++)
    if (armOf(id, ARMS, `u${i}`) === arm) found.push(`u${i}`);
  return found;
}

const eventsOf = async (id: string) =>
  (await db.collection("experiment_events").where("experiment", "==", id).get()).docs.map((doc) =>
    doc.data(),
  );

describe("an exposure", () => {
  it("is counted once per unit, in the unit's arm, with no trace of the unit", async () => {
    const { id, experiments } = experimentOf();
    const arm = experiments.arm(id, "visitor-1");
    expect(await experiments.expose(id, "visitor-1", T0)).toBe("counted");
    expect(await experiments.expose(id, "visitor-1", T0)).toBe("repeated");
    const events = await eventsOf(id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ experiment: id, arm, kind: "exposure", day: "2026-10-01" });
    expect(events[0]!.expiresAt.toDate()).toEqual(new Date("2027-03-30T12:00:00Z"));
    expect(JSON.stringify(events[0])).not.toContain("visitor-1");
  });

  it.each([
    ["an empty unit", ""],
    ["a unit that is no string", 7 as unknown as string],
    ["a unit of 201 characters", "u".repeat(201)],
  ])("is refused for %s", async (_case, unit) => {
    const { id, experiments, lines } = experimentOf();
    expect(await experiments.expose(id, unit)).toBe("invalid");
    expect(lines).toEqual(["[experiments] exposure refused: unit"]);
  });

  it("is refused for an experiment that was never defined", async () => {
    const { experiments } = experimentOf();
    expect(await experiments.expose("toString" as never, "visitor-1")).toBe("invalid");
  });
});

describe("a conversion", () => {
  it("is counted once per unit and goal, for a unit that was exposed", async () => {
    const { id, experiments } = experimentOf();
    await experiments.expose(id, "visitor-1", T0);
    expect(await experiments.convert(id, "visitor-1", "signup", T0)).toBe("counted");
    expect(await experiments.convert(id, "visitor-1", "signup", T0)).toBe("repeated");
    expect(await experiments.convert(id, "visitor-1", "paid", T0)).toBe("counted");
    expect((await eventsOf(id)).map((event) => event.kind).sort()).toEqual([
      "exposure",
      "paid",
      "signup",
    ]);
  });

  it("is not counted for a unit that never saw the experiment", async () => {
    const { id, experiments } = experimentOf();
    expect(await experiments.convert(id, "stranger", "signup")).toBe("not_exposed");
    expect(await eventsOf(id)).toEqual([]);
  });

  it("is refused for a goal the experiment does not have", async () => {
    const { id, experiments } = experimentOf();
    await experiments.expose(id, "visitor-1");
    expect(await experiments.convert(id, "visitor-1", "exposure" as never)).toBe("invalid");
    expect(await experiments.convert(id, "visitor-1", "refund" as never)).toBe("invalid");
  });
});

describe("a store that fails", () => {
  it("costs the count and never the act: the answer says so and the log names the code", async () => {
    const lines: string[] = [];
    const broken = {
      collection: () => {
        throw Object.assign(new Error("secret detail"), { code: 14 });
      },
    } as unknown as Firestore;
    const experiments = createExperiments({
      firestore: broken,
      experiments: defineExperiments({ x: { arms: ARMS, goals: ["signup"] } }),
      log: (line) => lines.push(line),
    });
    expect(await experiments.expose("x", "visitor-1")).toBe("failed");
    expect(await experiments.convert("x", "visitor-1", "signup")).toBe("failed");
    expect(lines).toEqual([
      "[experiments] exposure not counted: 14",
      "[experiments] conversion not counted: 14",
    ]);
  });
});

describe("the results", () => {
  it("count each arm, compare with the control and say whether the plan was reached", async () => {
    const { id, experiments } = experimentOf({ perArm: 6 });
    const control = unitsIn(id, "control", 6);
    const annual = unitsIn(id, "annual", 6);
    for (const unit of [...control, ...annual]) await experiments.expose(id, unit, T0);
    for (const unit of control.slice(0, 1)) await experiments.convert(id, unit, "signup", T0);
    for (const unit of annual.slice(0, 3)) await experiments.convert(id, unit, "signup", T0);
    await experiments.convert(id, annual[0]!, "paid", T0);

    const results = await experiments.results(id);
    expect(results.control).toBe("control");
    expect(results.arms).toEqual({
      control: {
        exposed: 6,
        goals: { signup: { converted: 1, rate: 1 / 6 }, paid: { converted: 0, rate: 0 } },
      },
      annual: {
        exposed: 6,
        goals: { signup: { converted: 3, rate: 0.5 }, paid: { converted: 1, rate: 1 / 6 } },
      },
    });
    expect(results.split).toEqual({ pValue: 1, mismatch: false });
    expect(results.reached).toBe(true);
    expect(Object.keys(results.comparisons)).toEqual(["annual"]);
    expect(results.comparisons.annual!.signup!.difference).toBeCloseTo(1 / 3, 10);
    expect(results.comparisons.annual!.signup!.pValue).toBeGreaterThan(0.05);
  });

  it("are empty before the first visitor", async () => {
    const { id, experiments } = experimentOf({ perArm: 100 });
    const results = await experiments.results(id);
    expect(results.arms.control).toEqual({
      exposed: 0,
      goals: { signup: { converted: 0, rate: null }, paid: { converted: 0, rate: null } },
    });
    expect(results.reached).toBe(false);
    expect(results.comparisons.annual).toEqual({ signup: null, paid: null });
  });

  it("carry no plan when the experiment set none", async () => {
    const { id, experiments } = experimentOf();
    expect((await experiments.results(id)).reached).toBeNull();
  });

  it("are refused for an experiment that was never defined", async () => {
    const { experiments } = experimentOf();
    await expect(experiments.results("nothing" as never)).rejects.toThrow("unknown experiment");
  });
});
