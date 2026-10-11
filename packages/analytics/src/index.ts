// How a product event is written, what happens when writing it fails, and how the log is read back.
import {
  FieldValue,
  type CollectionReference,
  type Firestore,
  type Transaction,
} from "firebase-admin/firestore";
import { daysBefore, engagement, type ActiveDay, type Engagement } from "./engagement.js";
import {
  eventKey,
  parseEvent,
  type EventDef,
  type EventInput,
  type EventTable,
  type Events,
  type RawInput,
} from "./events.js";

/** The root collection the log lives in: whoever operates the product counts across tenants. */
export const DEFAULT_COLLECTION = "product_events";

/** Firestore's ALREADY_EXISTS as the admin SDK reports it: the gRPC code. */
const ALREADY_EXISTS = 6;

export type AnalyticsConfig<E extends EventTable> = {
  firestore: Firestore;
  events: Events<E>;
  /** The IANA time zone a day is counted in, such as `America/Sao_Paulo`: the day your users work in. */
  timeZone: string;
  /** Default `product_events`. */
  collection?: string;
  /** Receives one line per refused or failed event: a field's path or an error code, never a value. */
  log?: (line: string) => void;
};

/** `already_recorded`: a `first` event whose row exists. `invalid`: the table refused it. */
export type Recorded = "recorded" | "already_recorded" | "invalid" | "failed";

export type RecordOptions = {
  /**
   * False makes a `daily` row exist without adding to its `count`: the person was active (a request
   * under a session that began days ago) but this was not a new visit.
   */
  counts?: boolean;
  /** The real instant of something that happened before the log existed, for a backfill. Default now. */
  at?: Date;
};

export type Analytics<E extends EventTable> = {
  /**
   * Records one event, idempotently, and never at the cost of the act that produced it. It cannot
   * throw: a metric is read once a day, and the act underneath it is a person signing in. A failure is
   * logged by its code and swallowed, and the answer says what happened.
   */
  record<T extends keyof E & string>(
    type: T,
    input: EventInput<E[T]>,
    options?: RecordOptions,
  ): Promise<Recorded>;
  /**
   * Records a `first` event inside the caller's transaction, so it commits with the write that caused
   * it or not at all. False when its row already exists. The opposite trade from `record`, on purpose:
   * here a failure fails the transaction, and an event the table refuses throws. It reads its row, so
   * call it before the transaction's own writes.
   */
  recordInTransaction<T extends keyof E & string>(
    tx: Transaction,
    type: T,
    input: EventInput<E[T]>,
  ): Promise<boolean>;
  /** The day `at` falls on in the configured time zone, `YYYY-MM-DD`. */
  dayOf(at?: Date): string;
  /** Who a `daily` user event names on each day from `from` to `to`, inclusive. */
  activeDays(type: keyof E & string, range: { from: string; to: string }): Promise<ActiveDay[]>;
  /** DAU, WAU, MAU, stickiness and frequency as of `today`, read from a `daily` user event. */
  engagement(
    type: keyof E & string,
    options?: { today?: string; period?: number },
  ): Promise<Engagement>;
};

export function createAnalytics<E extends EventTable>(config: AnalyticsConfig<E>): Analytics<E> {
  const { firestore, events } = config;
  const log = config.log ?? (() => {});
  const collection: CollectionReference = firestore.collection(
    config.collection ?? DEFAULT_COLLECTION,
  );
  // Throws here, at start-up, for a zone the runtime does not know.
  const dayFormat = new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const dayOf = (at: Date = new Date()) => dayFormat.format(at);

  function definition(type: string): EventDef {
    const def = events.table[type];
    if (!def) throw new Error(`unknown event ${type}`);
    return def;
  }

  function prepared(type: string, input: RawInput, at: Date) {
    const def = definition(type);
    const parsed = parseEvent(def, input);
    if (!parsed.ok) return { ok: false, path: parsed.path } as const;
    const day = dayOf(at);
    const { tenantId, userId, props } = parsed;
    return {
      ok: true,
      def,
      ref: collection.doc(eventKey(type, def, parsed, day)),
      fields: { type, tenantId, userId, day, ...props },
    } as const;
  }

  async function record(type: string, input: RawInput, options: RecordOptions = {}) {
    let step: ReturnType<typeof prepared>;
    try {
      step = prepared(type, input, options.at ?? new Date());
    } catch {
      log(`[analytics] event refused: unknown type`);
      return "invalid" as const;
    }
    if (!step.ok) {
      log(`[analytics] ${type} refused by its definition: ${step.path}`);
      return "invalid" as const;
    }
    try {
      if (step.def.keep === "first") {
        // `create` lets the first win: a merge would move its instant to the latest repeat.
        await step.ref.create({ ...step.fields, at: options.at ?? FieldValue.serverTimestamp() });
        return "recorded" as const;
      }
      await step.ref.set(
        {
          ...step.fields,
          count: FieldValue.increment(options.counts === false ? 0 : 1),
          lastAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      return "recorded" as const;
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      if (code === ALREADY_EXISTS) return "already_recorded" as const;
      // The code only: a message can carry what the event named.
      log(`[analytics] ${type} not recorded: ${String(code ?? "no code")}`);
      return "failed" as const;
    }
  }

  async function recordInTransaction(tx: Transaction, type: string, input: RawInput) {
    const step = prepared(type, input, new Date());
    if (!step.ok)
      throw new Error(`[analytics] ${type} refused by its definition: ${step.path}`);
    if (step.def.keep !== "first")
      throw new Error(`[analytics] ${type} tallies repeats and is not recorded in a transaction`);
    // A row already there is kept: creating the same id again would fail the whole transaction.
    if ((await tx.get(step.ref)).exists) return false;
    tx.create(step.ref, { ...step.fields, at: FieldValue.serverTimestamp() });
    return true;
  }

  async function activeDays(type: string, range: { from: string; to: string }) {
    const def = definition(type);
    if (def.subject !== "user" || def.keep !== "daily")
      throw new Error(`${type} is not a daily user event`);
    const found = await collection
      .where("type", "==", type)
      .where("day", ">=", range.from)
      .where("day", "<=", range.to)
      .select("day", "userId")
      .get();
    const byDay = new Map<string, Set<string>>();
    for (const doc of found.docs) {
      const day = doc.get("day") as string;
      byDay.set(day, (byDay.get(day) ?? new Set()).add(doc.get("userId") as string));
    }
    return [...byDay]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, users]) => ({ day, users: [...users] }));
  }

  return {
    record: record as Analytics<E>["record"],
    recordInTransaction: recordInTransaction as Analytics<E>["recordInTransaction"],
    dayOf,
    activeDays,
    async engagement(type, options = {}) {
      const today = options.today ?? dayOf();
      const period = options.period ?? 30;
      // The oldest point of the series still needs its own 30-day window.
      const from = daysBefore(today, period - 1 + 29);
      return engagement(await activeDays(type, { from, to: today }), today, period);
    },
  };
}

export { defineEvents, type EventDef, type EventInput, type EventTable, type Events, type PropKind } from "./events.js";
export { daysBefore, engagement, type ActiveDay, type Engagement } from "./engagement.js";
