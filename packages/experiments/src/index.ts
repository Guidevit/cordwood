// How an experiment's exposures and conversions are stored, and how its result is read.
import { FieldValue, Timestamp, type Firestore } from "firebase-admin/firestore";
import { EXPOSURE, armOf, eventKey, isUnit, type Definitions } from "./arms.js";
import { compare, splitCheck, type Comparison, type SplitCheck } from "./stats.js";

/** The root collection the events live in: a visitor has no tenant yet. */
export const DEFAULT_COLLECTION = "experiment_events";

/** Firestore's ALREADY_EXISTS as the admin SDK reports it: the gRPC code. */
const ALREADY_EXISTS = 6;
const DAY_MS = 24 * 60 * 60 * 1000;

export type ExperimentsConfig<D extends Definitions> = {
  firestore: Firestore;
  experiments: D;
  /** How long an event is kept. The TTL policy on `expiresAt` deletes it then. Default 180. */
  retentionDays?: number;
  /** Default `experiment_events`. */
  collection?: string;
  /** Receives one line per refused or failed event: a name or an error code, never a unit. */
  log?: (line: string) => void;
};

/**
 * `repeated`: this unit was already counted for it. `not_exposed`: a conversion of a unit that never
 * saw the experiment. `invalid`: an unknown experiment or goal, or a unit that is no string.
 */
export type Counting = "counted" | "repeated" | "not_exposed" | "invalid" | "failed";

type ArmOf<X> = X extends { arms: infer A } ? keyof A & string : never;
type GoalOf<X> = X extends { goals: readonly (infer G)[] } ? G & string : never;

export type ArmResult<G extends string> = {
  exposed: number;
  goals: Record<G, { converted: number; rate: number | null }>;
};

export type Results<A extends string, G extends string> = {
  /** The first arm, which the others are compared with. */
  control: A;
  arms: Record<A, ArmResult<G>>;
  split: SplitCheck;
  /** Whether every arm has its `perArm`. Null when the experiment set none. */
  reached: boolean | null;
  /** Each other arm against the control, per goal. Null while either has nobody. */
  comparisons: Partial<Record<A, Record<G, Comparison | null>>>;
};

export type Experiments<D extends Definitions> = {
  /** The arm of `unit`, derived and never stored. The same answer on every server, for as long as the id lasts. */
  arm<K extends keyof D & string>(experiment: K, unit: string): ArmOf<D[K]>;
  /**
   * Counts `unit` as having seen its arm, once. Call it where the arm is actually shown, and not for a
   * robot, a prefetch or a preview. It cannot throw: the page underneath matters more than its count.
   */
  expose<K extends keyof D & string>(experiment: K, unit: string, now?: Date): Promise<Counting>;
  /**
   * Counts a goal for `unit`, once, and only if the unit was exposed. Call it from the server route
   * that performs the act, never on a browser's word. It cannot throw.
   */
  convert<K extends keyof D & string>(
    experiment: K,
    unit: string,
    goal: GoalOf<D[K]>,
    now?: Date,
  ): Promise<Counting>;
  /** The counts per arm, the check of the split, and each arm against the control. */
  results<K extends keyof D & string>(
    experiment: K,
  ): Promise<Results<ArmOf<D[K]>, GoalOf<D[K]>>>;
};

export function createExperiments<D extends Definitions>(
  config: ExperimentsConfig<D>,
): Experiments<D> {
  const { firestore: db, experiments } = config;
  const log = config.log ?? (() => {});
  const retentionMs = (config.retentionDays ?? 180) * DAY_MS;
  const events = () => db.collection(config.collection ?? DEFAULT_COLLECTION);
  const defined = (id: string) => (Object.hasOwn(experiments, id) ? experiments[id]! : null);

  const event = (experiment: string, arm: string, kind: string, now: Date) => ({
    experiment,
    arm,
    kind,
    day: now.toISOString().slice(0, 10),
    at: FieldValue.serverTimestamp(),
    expiresAt: Timestamp.fromMillis(now.getTime() + retentionMs),
  });

  // One document per experiment, unit and kind, created and never updated: a repeat finds it there and
  // writes nothing, so a flood of reports for one unit costs no more than the first.
  async function count(key: string, data: object): Promise<Counting> {
    try {
      await events().doc(key).create(data);
      return "counted";
    } catch (error) {
      if ((error as { code?: unknown })?.code === ALREADY_EXISTS) return "repeated";
      throw error;
    }
  }

  const failed = (what: string, error: unknown): Counting => {
    log(`[experiments] ${what} not counted: ${(error as { code?: unknown })?.code ?? "no code"}`);
    return "failed";
  };

  return {
    arm(experiment, unit) {
      return armOf(experiment, experiments[experiment]!.arms, unit) as ArmOf<D[typeof experiment]>;
    },

    async expose(experiment, unit, now = new Date()) {
      const definition = defined(experiment);
      if (!definition || !isUnit(unit)) {
        log(`[experiments] exposure refused: ${definition ? "unit" : "experiment"}`);
        return "invalid";
      }
      try {
        const arm = armOf(experiment, definition.arms, unit);
        return await count(
          eventKey(experiment, unit, EXPOSURE),
          event(experiment, arm, EXPOSURE, now),
        );
      } catch (error) {
        return failed("exposure", error);
      }
    },

    async convert(experiment, unit, goal, now = new Date()) {
      const definition = defined(experiment);
      if (!definition || !isUnit(unit) || !definition.goals.includes(goal)) {
        log(`[experiments] conversion refused: ${definition ? "unit or goal" : "experiment"}`);
        return "invalid";
      }
      try {
        const exposure = await events().doc(eventKey(experiment, unit, EXPOSURE)).get();
        if (!exposure.exists) return "not_exposed";
        const arm = armOf(experiment, definition.arms, unit);
        return await count(eventKey(experiment, unit, goal), event(experiment, arm, goal, now));
      } catch (error) {
        return failed("conversion", error);
      }
    },

    async results(experiment) {
      type A = ArmOf<D[typeof experiment]>;
      type G = GoalOf<D[typeof experiment]>;
      const definition = defined(experiment);
      if (!definition) throw new Error(`unknown experiment: ${experiment}`);
      const names = Object.keys(definition.arms) as A[];
      const goals = definition.goals as readonly G[];
      const counted = async (arm: string, kind: string) =>
        (
          await events()
            .where("experiment", "==", experiment)
            .where("arm", "==", arm)
            .where("kind", "==", kind)
            .count()
            .get()
        ).data().count;
      const rows = await Promise.all(
        names.map(async (arm) => {
          const [exposed, ...converted] = await Promise.all(
            [EXPOSURE, ...goals].map((kind) => counted(arm, kind)),
          );
          return { arm, exposed: exposed!, converted };
        }),
      );
      const arms = Object.fromEntries(
        rows.map(({ arm, exposed, converted }) => [
          arm,
          {
            exposed,
            goals: Object.fromEntries(
              goals.map((goal, i) => [
                goal,
                { converted: converted[i]!, rate: exposed > 0 ? converted[i]! / exposed : null },
              ]),
            ),
          },
        ]),
      ) as Record<A, ArmResult<G>>;
      const control = rows[0]!;
      const comparisons = Object.fromEntries(
        rows.slice(1).map((row) => [
          row.arm,
          Object.fromEntries(
            goals.map((goal, i) => [
              goal,
              compare(
                { exposed: control.exposed, converted: control.converted[i]! },
                { exposed: row.exposed, converted: row.converted[i]! },
              ),
            ]),
          ),
        ]),
      ) as Partial<Record<A, Record<G, Comparison | null>>>;
      return {
        control: control.arm,
        arms,
        split: splitCheck(
          rows.map((row) => row.exposed),
          names.map((arm) => definition.arms[arm]!),
        ),
        reached:
          definition.perArm === undefined
            ? null
            : rows.every((row) => row.exposed >= definition.perArm!),
        comparisons,
      };
    },
  };
}

export { armOf, defineExperiments, type Definition, type Definitions } from "./arms.js";
export { compare, sampleSize, splitCheck, type Comparison, type Counted, type SplitCheck } from "./stats.js";
export { createVisitors, isPrefetch, isRobot, refusesTracking, type Visitors } from "./visitors.js";
