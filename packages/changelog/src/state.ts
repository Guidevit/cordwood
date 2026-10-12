// What is kept of each person about the release notes, and the code that lets them leave the e-mails
// with no session.
import { randomBytes } from "node:crypto";
import { isDocumentId, tenantRef } from "@cordwood/firebase";
import { Timestamp, type DocumentReference, type Firestore } from "firebase-admin/firestore";

/** Each person's state: tenants/{tenantId}/changelog_state/{userId}. */
export const STATE = "changelog_state";
/**
 * Whose exit code it is: changelog_exits/{code}. At the root because whoever follows the link has no
 * session, so no tenant is known until the code names it.
 */
export const EXITS = "changelog_exits";

export type EmailState = {
  on?: unknown;
  at?: unknown;
  source?: unknown;
  exit?: unknown;
  sent?: unknown;
};

export const stateRef = (db: Firestore, tenantId: string, userId: string): DocumentReference => {
  if (!isDocumentId(userId)) throw new Error("invalid user id");
  return tenantRef(db, tenantId).collection(STATE).doc(userId);
};

export const exitRef = (db: Firestore, code: string): DocumentReference =>
  db.collection(EXITS).doc(code);

// 32 random bytes in base64url: 43 characters.
const EXIT_CODE = /^[A-Za-z0-9_-]{43}$/;

/** Whether `code` could be one this package minted, from the string alone: a mangled link costs no read. */
export function isExitCode(code: unknown): code is string {
  return typeof code === "string" && EXIT_CODE.test(code) && isDocumentId(code);
}

export const newExitCode = (): string => randomBytes(32).toString("base64url");

const VERSION = /^\d+(\.\d+)*$/;

/**
 * Whether a person marked as sent `had` already has `version` or a later one. Numbers, part by part, so
 * 2.9.0 is older than 2.10.0. "Not this version" is not the question: a build rolled back to the
 * release before would then send its notes to everyone who had the newer ones, and the newer ones again
 * when the release returned. Versions that are not dotted numbers are compared for equality only.
 */
export function alreadyHad(had: unknown, version: string): boolean {
  if (typeof had !== "string") return false;
  if (!VERSION.test(had) || !VERSION.test(version)) return had === version;
  const [has, asks] = [had, version].map((v) => v.split(".").map(Number));
  for (let i = 0; i < Math.max(has!.length, asks!.length); i++) {
    const difference = (has![i] ?? 0) - (asks![i] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

export type Subscription = { on: boolean; at: Date | null };

const NEVER_ANSWERED: Subscription = { on: false, at: null };

/**
 * The person's answer and when it last changed. Only a whole record counts: anything that is not a
 * boolean with a timestamp reads as never answered, so nothing malformed can turn into a yes.
 */
export function subscriptionOf(email: EmailState | undefined): Subscription {
  if (typeof email?.on !== "boolean" || !(email.at instanceof Timestamp)) return NEVER_ANSWERED;
  return { on: email.on, at: email.at.toDate() };
}
