// Which experiments exist, and which arm a unit falls into.
import { createHash } from "node:crypto";

/**
 * One experiment. `arms` maps each arm to its weight, and the first one is the control. `goals` are the
 * acts counted as conversions. `perArm` is the number of units each arm needs before the result is
 * read, decided before the first visitor (see `sampleSize`).
 */
export type Definition = {
  arms: Readonly<Record<string, number>>;
  goals: readonly string[];
  perArm?: number;
};

export type Definitions = Readonly<Record<string, Definition>>;

/** The kind an exposure is stored under, so no goal may take the name. */
export const EXPOSURE = "exposure";

// Lowercase, starting with a letter: an id that reads the same in a URL, a field and a file name, and
// that is never a whole number, which an object would list out of the order it was written in.
const NAME = /^[a-z][a-z0-9_-]{0,39}$/;

/**
 * Checks the experiments and answers them unchanged. An experiment's id is also what its split is cut
 * with, so a new round gets a new id: reusing one carries the old split, and the old counts, into it.
 */
export function defineExperiments<const D extends Definitions>(definitions: D): D {
  for (const [id, { arms, goals, perArm }] of Object.entries(definitions)) {
    const fail = (what: string): never => {
      throw new Error(`experiment ${id}: ${what}`);
    };
    if (!NAME.test(id)) fail("the id must be lowercase letters, digits, _ or -, from a letter");
    const names = Object.keys(arms);
    if (names.length === 0) fail("it has no arm");
    for (const name of names) {
      if (!NAME.test(name)) fail(`the arm ${name} is not a valid name`);
      const weight = arms[name]!;
      if (!Number.isInteger(weight) || weight < 1 || weight > 1000)
        fail(`the weight of ${name} must be a whole number from 1 to 1000`);
    }
    if (new Set(goals).size !== goals.length) fail("a goal is listed twice");
    for (const goal of goals)
      if (!NAME.test(goal) || goal === EXPOSURE) fail(`the goal ${goal} is not a valid name`);
    if (perArm !== undefined && (!Number.isInteger(perArm) || perArm < 1))
      fail("perArm must be a whole number above zero");
  }
  return definitions;
}

/** A unit is whatever is being split: a visitor's id, a user's, a tenant's. */
export function isUnit(unit: unknown): unit is string {
  return typeof unit === "string" && unit.length > 0 && unit.length <= 200;
}

/**
 * The arm of `unit` in the experiment `id`: the first 32 bits of sha256(id, unit), over the total
 * weight. Stored nowhere. Every server that asks derives the same arm from the same two strings, so
 * there is no second record that could disagree with it.
 */
export function armOf(id: string, arms: Readonly<Record<string, number>>, unit: string): string {
  const names = Object.keys(arms);
  const total = names.reduce((sum, name) => sum + arms[name]!, 0);
  const point = createHash("sha256").update(`${id}\n${unit}`).digest().readUInt32BE(0) % total;
  let passed = 0;
  for (const name of names) {
    passed += arms[name]!;
    if (point < passed) return name;
  }
  return names[0]!;
}

/** The document an event is stored in: one per experiment, unit and kind, so a repeat finds it there. */
export function eventKey(id: string, unit: string, kind: string): string {
  return createHash("sha256").update(`${id}\n${unit}\n${kind}`).digest("hex");
}
