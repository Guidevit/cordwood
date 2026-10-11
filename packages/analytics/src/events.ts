// Which product events an app has, what each may carry, and what makes one the same event twice.
//
// These events are read by whoever operates the product, who belongs to no tenant. So an event carries
// the tenant and the person as ids and nothing else. The table is closed: a field nobody declared
// refuses the event, so a leak would have to be added here, in the open, not slipped in at a call site.

/**
 * What a property may hold: one of a fixed list of words, an opaque id (letters, digits and `_.:-`,
 * at most 128, so never an e-mail or a sentence), or a number.
 */
export type PropKind = readonly string[] | "id" | "number";

export type EventDef = {
  /**
   * Who the event is about. `user`: a person, by their uid. `tenant`: the tenant itself, naming no
   * person (a subscription that changed, a first import).
   */
  subject: "user" | "tenant";
  /**
   * `daily`: one row per subject per day, and a repeat is added to the row's `count`. That is what
   * makes daily active users a count of people while the sum of `count` is their visits.
   *
   * `first`: the row is created once and keeps its instant. A repeat is refused, so "the first time a
   * tenant did X" never moves to the latest time.
   */
  keep: "daily" | "first";
  /** The other fields the event carries, all required. */
  props?: Readonly<Record<string, PropKind>>;
  /**
   * The properties that are part of what makes the event the same one: a feature's name on a daily
   * use, the payment provider's event id on a billing change.
   */
  key?: readonly string[];
};

export type EventTable = Readonly<Record<string, EventDef>>;

type ValueOf<K extends PropKind> = K extends readonly (infer V)[]
  ? V
  : K extends "number"
    ? number
    : string;

type PropsOf<D extends EventDef> = D["props"] extends Readonly<Record<string, PropKind>>
  ? { -readonly [P in keyof D["props"]]: ValueOf<D["props"][P]> }
  : undefined;

/** What `record` takes for one event type. */
export type EventInput<D extends EventDef> = { tenantId: string } & (D["subject"] extends "user"
  ? { userId: string }
  : { userId?: undefined }) &
  (PropsOf<D> extends undefined ? { props?: undefined } : { props: PropsOf<D> });

export type Events<E extends EventTable> = {
  readonly table: E;
  readonly types: readonly (keyof E & string)[];
};

const NAME = /^[a-z][a-z0-9_]{0,63}$/;
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const RESERVED: ReadonlySet<string> = new Set([
  "type",
  "tenantId",
  "userId",
  "day",
  "count",
  "at",
  "lastAt",
]);

/**
 * The app's events. Each type arrives with the code that writes it: an event, once stored, is not
 * renamed later.
 *
 *     const events = defineEvents({
 *       session_active: { subject: "user", keep: "daily" },
 *       feature_used: { subject: "user", keep: "daily", props: { feature: ["search", "export"] }, key: ["feature"] },
 *       first_import: { subject: "tenant", keep: "first" },
 *     });
 */
export function defineEvents<const E extends EventTable>(table: E): Events<E> {
  const types = Object.keys(table) as (keyof E & string)[];
  if (types.length === 0) throw new Error("defineEvents needs at least one event");
  for (const type of types) {
    const def = table[type]!;
    if (!NAME.test(type)) throw new Error(`event name ${type} must be lower_snake_case`);
    for (const prop of Object.keys(def.props ?? {})) {
      if (!NAME.test(prop) && !/^[a-z][A-Za-z0-9]{0,63}$/.test(prop))
        throw new Error(`property ${type}.${prop} is not a field name`);
      if (RESERVED.has(prop)) throw new Error(`property ${type}.${prop} is a reserved field`);
    }
    for (const prop of def.key ?? [])
      if (!Object.hasOwn(def.props ?? {}, prop))
        throw new Error(`key ${type}.${prop} is not one of the event's properties`);
  }
  return { table, types };
}

export type RawInput = {
  tenantId?: unknown;
  userId?: unknown;
  props?: Record<string, unknown>;
};

/** The parsed event, or the path of the first thing wrong with it. */
export type Parsed =
  | { ok: true; tenantId: string; userId: string | null; props: Record<string, string | number> }
  | { ok: false; path: string };

function propOk(kind: PropKind, value: unknown): value is string | number {
  if (kind === "number") return typeof value === "number" && Number.isFinite(value);
  if (kind === "id") return typeof value === "string" && ID.test(value);
  return typeof value === "string" && kind.includes(value);
}

/** Checks `input` against the event's row. Nothing reaches Firestore that the table did not list. */
export function parseEvent(def: EventDef, input: RawInput): Parsed {
  const bad = (path: string): Parsed => ({ ok: false, path });
  if (typeof input.tenantId !== "string" || !ID.test(input.tenantId)) return bad("tenantId");
  // Both ways: a type that names a person must carry the uid, and a type that names none must not.
  // An event keyed on a missing uid becomes one ghost person standing for all of them.
  const named = input.userId !== undefined && input.userId !== null;
  if (def.subject === "user" && (typeof input.userId !== "string" || !ID.test(input.userId)))
    return bad("userId");
  if (def.subject === "tenant" && named) return bad("userId");
  const declared = def.props ?? {};
  const given = input.props ?? {};
  for (const name of Object.keys(given))
    if (!Object.hasOwn(declared, name)) return bad(`props.${name}`);
  const props: Record<string, string | number> = {};
  for (const [name, kind] of Object.entries(declared)) {
    const value = given[name];
    if (!propOk(kind, value)) return bad(`props.${name}`);
    props[name] = value;
  }
  return {
    ok: true,
    tenantId: input.tenantId,
    userId: def.subject === "user" ? (input.userId as string) : null,
    props,
  };
}

/** The document id, which is what makes a repeated event land on the same row. */
export function eventKey(
  type: string,
  def: EventDef,
  event: { tenantId: string; userId: string | null; props: Record<string, string | number> },
  day: string,
): string {
  const parts = [
    type,
    ...(def.keep === "daily" ? [day] : []),
    event.userId ?? event.tenantId,
    ...(def.key ?? []).map((prop) => String(event.props[prop])),
  ];
  // Each part is encoded, separator included, so `a~b` + `c` and `a` + `b~c` are different keys. A
  // dot is encoded too: Firestore refuses `.` and `..` as a document id.
  const encode = (part: string) =>
    encodeURIComponent(part).replaceAll(".", "%2E").replaceAll("~", "%7E");
  return parts.map(encode).join("~");
}
