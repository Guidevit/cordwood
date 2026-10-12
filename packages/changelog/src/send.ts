// Who receives a release's notes by e-mail, how "once per person per version" is kept, and when a run
// stops believing the mail service's refusals.
import type { Auth } from "firebase-admin/auth";
import { FieldValue, Timestamp, type DocumentReference, type Firestore } from "firebase-admin/firestore";
import {
  STATE,
  alreadyHad,
  exitRef,
  isExitCode,
  newExitCode,
  type EmailState,
} from "./state.js";

/**
 * What a failed delivery means for the run.
 *
 * `message`: the service refused this one message. It is counted and the run goes on.
 * `sender`: nothing can be sent at all (no key, the sender refused, the rate hit). The person's mark
 * goes back and the run stops, since it would otherwise use the version up for everybody.
 * `unknown`: no answer came. The run stops with that one mark kept: the message may have left.
 */
export type Failure = "message" | "sender" | "unknown";

/** The message the app delivers, in its own words and template. */
export type Delivery<N> = {
  to: string;
  note: N;
  /** The page where the person leaves, with their code after `#`, where no server log sees it. */
  unsubscribeUrl: string;
  /** For the `List-Unsubscribe` header: a mailbox provider POSTs to it (RFC 8058). */
  oneClickUrl: string;
  /** When the person asked for these e-mails, for a footer that says so. */
  subscribedAt: Date;
};

export type SendResult = { version: string | null; sent: number; failed: number };

export type SendConfig<N extends { version: string }> = {
  firestore: Firestore;
  auth: Auth;
  origin: string;
  unsubscribePath: string;
  oneClickPath: string;
  log: (line: string) => void;
  deliver: (delivery: Delivery<N>) => Promise<void>;
  classify: (error: unknown) => Failure;
};

/**
 * The default reading of a delivery's error, which fits `@cordwood/email`: an error with a `status` of
 * null never got an answer, 401, 403, 429 and 5xx are about the sender, any other status is about the
 * one message, and an error with no `status` means nothing was handed over.
 */
export function classifyFailure(error: unknown): Failure {
  const status = (error as { status?: unknown } | null)?.status;
  if (status === null) return "unknown";
  if (typeof status !== "number") return "sender";
  return status === 401 || status === 403 || status === 429 || status >= 500 ? "sender" : "message";
}

/** The run stopped because nothing can be sent: `cause` is the delivery's own error. */
export class SendStopped extends Error {
  override name = "SendStopped";
  readonly reason: Exclude<Failure, "message">;
  constructor(reason: Exclude<Failure, "message">, cause: unknown) {
    super(`the release notes run stopped: ${reason}`, { cause });
    this.reason = reason;
  }
}

type Held = { state: DocumentReference; before: unknown };
type Claim = { code: string; subscribedAt: Date; before: unknown };

// getUsers takes at most 100 identifiers per call.
const PER_LOOKUP = 100;
// Refusals of a message, while nothing was accepted, that a run holds before it stops believing them.
const REFUSALS_BEFORE_DOUBT = 3;

/**
 * Takes the mark back, for a message that certainly did not leave: only if the row still holds this
 * very mark.
 */
async function giveBack(state: DocumentReference, version: string, before: unknown): Promise<void> {
  await state.firestore.runTransaction(async (tx) => {
    const email = (await tx.get(state)).get("email") as EmailState | undefined;
    if (email?.sent !== version) return;
    tx.update(state, { "email.sent": typeof before === "string" ? before : FieldValue.delete() });
  });
}

/**
 * What one run knows about refused messages. A refusal says "this message is wrong", which holds for
 * one person and not for all: when the sender is malformed the service refuses every message with it,
 * and counting each as that person's failure would use the version up for everybody. So a refusal that
 * arrives before the run has had a single message accepted is held, its mark kept for now. The third
 * such refusal, or the end of a run with nothing accepted, gives every held mark back and stops the
 * run. The first accepted message proves the sender works, and none is held after it.
 */
class Refusals {
  private accepted = 0;
  private held: Held[] = [];
  private last: unknown = null;

  accept(): void {
    this.accepted += 1;
    this.held = [];
  }

  async refused(held: Held, version: string, error: unknown): Promise<void> {
    if (this.accepted > 0) return;
    this.held.push(held);
    this.last = error;
    if (this.held.length >= REFUSALS_BEFORE_DOUBT) await this.stop(version);
  }

  /** The end of the run: nothing accepted and something refused is a sender that cannot send. */
  async end(version: string): Promise<void> {
    if (this.accepted === 0 && this.held.length > 0) await this.stop(version);
  }

  /** Gives every held mark back, for a run that stops while nothing was accepted. */
  async release(version: string): Promise<void> {
    if (this.accepted > 0) return;
    const held = this.held;
    this.held = [];
    for (const { state, before } of held) await giveBack(state, version, before);
  }

  private async stop(version: string): Promise<never> {
    await this.release(version);
    throw new SendStopped("sender", this.last);
  }
}

/**
 * The addresses that may be written to, by person: an account that exists, is not disabled, whose
 * address its owner confirmed and which still belongs to that tenant. Read at send time, so an address
 * is never copied anywhere.
 */
async function addressesOf(
  auth: Auth,
  people: { tenantId: string; userId: string }[],
): Promise<Map<string, string>> {
  const tenantOf = new Map(people.map((p) => [p.userId, p.tenantId]));
  const ids = [...tenantOf.keys()];
  const batches = Array.from({ length: Math.ceil(ids.length / PER_LOOKUP) }, (_, i) =>
    ids.slice(i * PER_LOOKUP, (i + 1) * PER_LOOKUP).map((uid) => ({ uid })),
  );
  const found = await Promise.all(batches.map((batch) => auth.getUsers(batch)));
  return new Map(
    found
      .flatMap((f) => f.users)
      .filter((u) => !u.disabled && u.emailVerified && u.email)
      // An account another tenant holds now is no longer this tenant's person.
      .filter((u) => {
        const claimed: unknown = u.customClaims?.tenant;
        return claimed === undefined || claimed === tenantOf.get(u.uid);
      })
      .map((u) => [u.uid, u.email!]),
  );
}

/**
 * Marks `version` as sent on the person's state before the message leaves, and answers what the
 * message needs. Null when the answer is no longer on or the row already had this version or a later
 * one. In a transaction, so two runs at once hand the send to one of them, and an exit taken a moment
 * before wins.
 */
async function claim(
  db: Firestore,
  state: DocumentReference,
  who: { tenantId: string; userId: string },
  version: string,
  now: Date,
): Promise<Claim | null> {
  return db.runTransaction(async (tx) => {
    const email = (await tx.get(state)).get("email") as EmailState | undefined;
    if (email?.on !== true || alreadyHad(email.sent, version)) return null;
    if (!(email.at instanceof Timestamp)) return null;
    const code = isExitCode(email.exit) ? email.exit : newExitCode();
    if (code !== email.exit)
      tx.set(exitRef(db, code), { ...who, createdAt: Timestamp.fromDate(now) });
    tx.update(state, { "email.sent": version, "email.exit": code });
    return { code, subscribedAt: email.at.toDate(), before: email.sent };
  });
}

/** The page's link, with the code after `#`. */
export function unsubscribeUrl(origin: string, path: string, code: string): string {
  const url = new URL(path, origin);
  url.hash = new URLSearchParams({ token: code }).toString();
  return url.toString();
}

/** The one-click address. The code is in the query because the protocol gives a provider nothing else to send. */
export function oneClickUrl(origin: string, path: string, code: string): string {
  const url = new URL(path, origin);
  url.searchParams.set("t", code);
  return url.toString();
}

/**
 * One run: `note` to every person, in every tenant, who asked and has had no version this recent. One
 * message each, carrying only that person's own way out. The state is marked first and the message
 * sent after, so a failure can lose one person's message for one version and can never send it twice.
 */
export async function sendNote<N extends { version: string }>(
  config: SendConfig<N>,
  note: N,
  now: Date,
): Promise<SendResult> {
  const { firestore: db, auth } = config;
  const version = note.version;
  const result: SendResult = { version, sent: 0, failed: 0 };
  const subscribed = await db.collectionGroup(STATE).where("email.on", "==", true).get();
  const pending = subscribed.docs
    // A collection group matches any collection of that name: only a tenant's own counts.
    .filter((doc) => doc.ref.parent.parent?.parent.id === "tenants")
    .filter((doc) => !alreadyHad((doc.get("email") as EmailState).sent, version))
    .map((doc) => ({ state: doc.ref, tenantId: doc.ref.parent.parent!.id, userId: doc.id }));
  if (pending.length === 0) return result;
  const addresses = await addressesOf(auth, pending);
  const run = new Refusals();
  for (const { state, tenantId, userId } of pending) {
    const to = addresses.get(userId);
    if (!to) continue;
    const claimed = await claim(db, state, { tenantId, userId }, version, now);
    if (!claimed) continue;
    try {
      await config.deliver({
        to,
        note,
        unsubscribeUrl: unsubscribeUrl(config.origin, config.unsubscribePath, claimed.code),
        oneClickUrl: oneClickUrl(config.origin, config.oneClickPath, claimed.code),
        subscribedAt: claimed.subscribedAt,
      });
      result.sent += 1;
      run.accept();
    } catch (error) {
      const failure = config.classify(error);
      if (failure === "sender") {
        await giveBack(state, version, claimed.before);
        await run.release(version);
        throw new SendStopped("sender", error);
      }
      if (failure === "unknown") {
        await run.release(version);
        throw new SendStopped("unknown", error);
      }
      result.failed += 1;
      await run.refused({ state, before: claimed.before }, version, error);
    }
  }
  await run.end(version);
  return result;
}
