// Release notes inside the app, and by e-mail for whoever asked.
import { isDocumentId } from "@cordwood/firebase";
import type { Auth } from "firebase-admin/auth";
import { Timestamp, type Firestore } from "firebase-admin/firestore";
import {
  classifyFailure,
  sendNote,
  type Delivery,
  type Failure,
  type SendResult,
} from "./send.js";
import {
  alreadyHad,
  exitRef,
  isExitCode,
  newExitCode,
  stateRef,
  subscriptionOf,
  type EmailState,
  type Subscription,
} from "./state.js";

export type ChangelogConfig<N extends { version: string }> = {
  firestore: Firestore;
  /** Read at send time for each person's confirmed address. */
  auth: Auth;
  /** The app's releases, newest first. Each has a `version`, and whatever else your screens show. */
  notes: readonly N[];
  /** The app's own origin, for the links an e-mail carries. Never from a request's Host header. */
  origin: string;
  /** The page a person leaves the e-mails on. Default `/changelog/unsubscribe`. */
  unsubscribePath?: string;
  /** The route a mailbox provider's one-click unsubscribe POSTs to. Default `/api/changelog/unsubscribe`. */
  oneClickPath?: string;
  log?: (line: string) => void;
};

/** A report from the mail service about an address: a spam complaint, a bounce, an unsubscribe made there. */
export type MailEvent = { email: string; at: Date; kind?: string };

export type Changelog<N extends { version: string }> = {
  /** The newest release, and whether this person has opened the notes since it came out. */
  status(tenantId: string, userId: string): Promise<{ latest: N | null; unread: boolean }>;
  /** Records the newest release as read by this person. */
  markRead(tenantId: string, userId: string): Promise<void>;
  /** Whether the person receives the notes by e-mail, and when they last said so. */
  subscription(tenantId: string, userId: string): Promise<Subscription>;
  /**
   * Records the person's answer. `source` says where it was given (`signup`, `settings`), kept beside
   * the answer as evidence of the consent. A yes starts at the next release: nobody receives, an hour
   * after asking, the notes of a version that was live before they asked.
   */
  subscribe(
    tenantId: string,
    userId: string,
    on: boolean,
    source: string,
    now?: Date,
  ): Promise<Subscription>;
  /**
   * Follows a link's code: the person it names stops receiving the notes. It can only turn them off.
   * Unknown, repeated and malformed codes end the same way, in silence. Answer every call alike, so a
   * link tells nobody whether an address is on the list.
   */
  unsubscribe(code: unknown, now?: Date): Promise<void>;
  /**
   * Applies the mail service's reports: each one ends the e-mails of the person whose account holds
   * its address. Only for an answer that is on, and only when the event happened after it was given,
   * so a replayed batch never undoes a later yes.
   */
  applyMailEvents(events: readonly MailEvent[]): Promise<{ ended: number }>;
  /**
   * One run: the newest release's notes to everyone who asked and has not had it. Call it from a
   * scheduled route. Throws `SendStopped` when nothing can be sent.
   */
  send(
    deliver: (delivery: Delivery<N>) => Promise<void>,
    options?: { classify?: (error: unknown) => Failure; now?: Date },
  ): Promise<SendResult>;
  /** Forgets a person who left the tenant: their state and their exit code. */
  forget(tenantId: string, userId: string): Promise<void>;
};

function originOf(value: string): string {
  let url: URL | null = null;
  try {
    url = new URL(value);
  } catch {}
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:"))
    throw new Error("origin must be an http(s) origin");
  return url.origin;
}

export function createChangelog<N extends { version: string }>(
  config: ChangelogConfig<N>,
): Changelog<N> {
  const { firestore: db, auth, notes } = config;
  const origin = originOf(config.origin);
  const log = config.log ?? (() => {});
  const latest = notes[0] ?? null;

  const off = (email: EmailState, at: Date, source: string) => ({
    on: false,
    at: Timestamp.fromDate(at),
    source,
    ...(typeof email.exit === "string" ? { exit: email.exit } : {}),
    ...(typeof email.sent === "string" ? { sent: email.sent } : {}),
  });

  return {
    async status(tenantId, userId) {
      if (!latest) return { latest: null, unread: false };
      const read: unknown = (await stateRef(db, tenantId, userId).get()).get("read");
      return { latest, unread: !alreadyHad(read, latest.version) };
    },

    async markRead(tenantId, userId) {
      if (!latest) return;
      await stateRef(db, tenantId, userId).set({ read: latest.version }, { merge: true });
    },

    async subscription(tenantId, userId) {
      return subscriptionOf(
        (await stateRef(db, tenantId, userId).get()).get("email") as EmailState | undefined,
      );
    },

    // A no is recorded as a no with its day, never by removing the field. A yes carries the person's
    // way out: the code a message's link will hold, minted the first time and kept from then on,
    // through every no and yes after it, so no message ever sent holds a link that stopped working.
    async subscribe(tenantId, userId, on, source, now = new Date()) {
      const state = stateRef(db, tenantId, userId);
      const at = Timestamp.fromDate(now);
      await db.runTransaction(async (tx) => {
        const before = ((await tx.get(state)).get("email") ?? {}) as EmailState;
        const kept = isExitCode(before.exit) ? before.exit : null;
        const exit = kept ?? (on ? newExitCode() : null);
        if (exit && exit !== kept) tx.set(exitRef(db, exit), { tenantId, userId, createdAt: at });
        const sent = on && latest ? latest.version : before.sent;
        tx.set(
          state,
          {
            email: {
              on,
              at,
              source,
              ...(exit ? { exit } : {}),
              ...(typeof sent === "string" ? { sent } : {}),
            },
          },
          { mergeFields: ["email"] },
        );
      });
      return { on, at: now };
    },

    async unsubscribe(code, now = new Date()) {
      if (!isExitCode(code)) return;
      const exit = exitRef(db, code);
      await db.runTransaction(async (tx) => {
        const owner = (await tx.get(exit)).data() as
          | { tenantId?: unknown; userId?: unknown }
          | undefined;
        if (!owner) return;
        const state =
          isDocumentId(owner.tenantId) && isDocumentId(owner.userId)
            ? stateRef(db, owner.tenantId, owner.userId)
            : null;
        const person = state ? await tx.get(state) : null;
        // A code that names no one, or someone since forgotten: it goes, and nothing else is touched.
        if (!state || !person?.exists) {
          tx.delete(exit);
          return;
        }
        const email = person.get("email") as EmailState | undefined;
        if (email?.on !== true || email.exit !== code) return;
        tx.update(state, { email: off(email, now, "unsubscribe") });
      });
    },

    async applyMailEvents(events) {
      // An address is looked up once however many events name it.
      const lookups = new Map<string, Promise<ReturnType<typeof stateRef> | null>>();
      const stateOfAddress = (email: string) => {
        if (!lookups.has(email))
          lookups.set(
            email,
            auth.getUserByEmail(email).then(
              (account) => {
                const tenant: unknown = account.customClaims?.tenant;
                // A path in the claim would reach another collection.
                return isDocumentId(tenant) ? stateRef(db, tenant, account.uid) : null;
              },
              (error: { code?: unknown }) => {
                if (error.code === "auth/user-not-found" || error.code === "auth/invalid-email")
                  return null;
                throw error;
              },
            ),
          );
        return lookups.get(email)!;
      };
      let ended = 0;
      let failure: { error: unknown } | null = null;
      // An event that fails does not cost the others theirs. The first failure is thrown at the end,
      // so the caller asks for the batch again, and what was applied is skipped then.
      for (const event of events) {
        try {
          const state = await stateOfAddress(event.email);
          if (!state) continue;
          const done = await db.runTransaction(async (tx) => {
            const email = (await tx.get(state)).get("email") as EmailState | undefined;
            if (email?.on !== true || !(email.at instanceof Timestamp)) return false;
            if (event.at.getTime() <= email.at.toMillis()) return false;
            tx.update(state, { email: off(email, event.at, event.kind ?? "mail_event") });
            return true;
          });
          if (done) ended += 1;
        } catch (error) {
          failure ??= { error };
        }
      }
      if (failure) throw failure.error;
      return { ended };
    },

    async send(deliver, options = {}) {
      if (!latest) return { version: null, sent: 0, failed: 0 };
      return sendNote(
        {
          firestore: db,
          auth,
          origin,
          unsubscribePath: config.unsubscribePath ?? "/changelog/unsubscribe",
          oneClickPath: config.oneClickPath ?? "/api/changelog/unsubscribe",
          log,
          deliver,
          classify: options.classify ?? classifyFailure,
        },
        latest,
        options.now ?? new Date(),
      );
    },

    async forget(tenantId, userId) {
      const state = stateRef(db, tenantId, userId);
      const exit = ((await state.get()).get("email") as EmailState | undefined)?.exit;
      await state.delete();
      if (isExitCode(exit)) await exitRef(db, exit).delete();
    },
  };
}

export { SendStopped, classifyFailure, type Delivery, type Failure, type SendResult } from "./send.js";
export { alreadyHad, isExitCode, type Subscription } from "./state.js";
