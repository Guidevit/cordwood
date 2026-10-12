// Which tours a person has seen, and how each one ended. Kept on the server, so a tour seen in one
// browser does not open again in another.
import { tenantRef } from "@cordwood/firebase";
import { Timestamp, type Firestore } from "firebase-admin/firestore";

/** Each person's tours: tenants/{tenantId}/tour_state/{userId}. */
export const STATE = "tour_state";

const NAME = /^[a-z][a-z0-9_-]{0,39}$/;

export type ToursConfig<T extends string> = {
  firestore: Firestore;
  /** Every tour the app has. No other id is recorded. */
  tours: readonly T[];
  /** The highest step a skipped tour may report. Default 20. */
  maxStep?: number;
};

export type EndInput = {
  tenantId: string;
  userId: string;
  tour: unknown;
  /** `skipped` is what Escape and "Skip" send. */
  how: unknown;
  /** The step the person was on when they skipped, from 1. */
  step?: unknown;
  now?: Date;
};

/**
 * `recorded`: the first time this person ended this tour. `already`: they had, and the first ending
 * was kept. `invalid`: an unknown tour, another `how`, or a skip with no step this package accepts.
 */
export type Ended<T extends string> = {
  status: "recorded" | "already" | "invalid";
  seen: T[];
};

export type Tours<T extends string> = {
  /** The tours this person has ended, in the order of the list. */
  seen(tenantId: string, userId: string): Promise<T[]>;
  /**
   * Records how a tour ended, once. Pass the request's fields as they arrived. The first ending is the
   * one that says whether the tour worked, so a later one never replaces it.
   */
  end(input: EndInput): Promise<Ended<T>>;
  /** Forgets a person who left the tenant. */
  forget(tenantId: string, userId: string): Promise<void>;
};

type Stored = Record<string, unknown>;

export function createTours<const T extends string>(config: ToursConfig<T>): Tours<T> {
  const { firestore: db, tours } = config;
  const maxStep = config.maxStep ?? 20;
  for (const tour of tours)
    if (!NAME.test(tour))
      throw new Error(`tour ${tour}: lowercase letters, digits, _ or -, from a letter`);
  const stateRef = (tenantId: string, userId: string) =>
    tenantRef(db, tenantId).collection(STATE).doc(userId);
  const seenIn = (stored: unknown): T[] => {
    const held = (stored && typeof stored === "object" ? stored : {}) as Stored;
    return tours.filter((tour) => Object.hasOwn(held, tour));
  };
  const isTour = (tour: unknown): tour is T => (tours as readonly unknown[]).includes(tour);

  return {
    async seen(tenantId, userId) {
      return seenIn((await stateRef(tenantId, userId).get()).get("tours"));
    },

    async end({ tenantId, userId, tour, how, step, now = new Date() }) {
      const state = stateRef(tenantId, userId);
      const skipped = how === "skipped";
      const sound =
        isTour(tour) &&
        (how === "completed" ||
          (skipped && Number.isInteger(step) && (step as number) >= 1 && (step as number) <= maxStep));
      if (!sound) return { status: "invalid", seen: seenIn((await state.get()).get("tours")) };
      return db.runTransaction(async (tx) => {
        const held = ((await tx.get(state)).get("tours") ?? {}) as Stored;
        if (Object.hasOwn(held, tour)) return { status: "already" as const, seen: seenIn(held) };
        const ending = { how, at: Timestamp.fromDate(now), ...(skipped ? { step } : {}) };
        tx.set(state, { tours: { [tour]: ending } }, { merge: true });
        return { status: "recorded" as const, seen: seenIn({ ...held, [tour]: ending }) };
      });
    },

    async forget(tenantId, userId) {
      await stateRef(tenantId, userId).delete();
    },
  };
}
