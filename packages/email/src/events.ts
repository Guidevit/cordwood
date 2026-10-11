// SendGrid's signed Event Webhook: the signature check over the raw bytes, and the events worth acting on.
//
// The service signs `timestamp header + raw body` with ECDSA over SHA-256 and sends the signature as
// Base64 of a DER encoding. The check runs on the bytes as received, before any JSON parsing: a parsed
// and re-serialised body would not verify.
import { createPublicKey, verify, type KeyObject } from "node:crypto";

const SIGNATURE_HEADER = "X-Twilio-Email-Event-Webhook-Signature";
const TIMESTAMP_HEADER = "X-Twilio-Email-Event-Webhook-Timestamp";

/**
 * What an application acts on: a spam report, a mailbox that refused for good, or an address SendGrid
 * itself will no longer write to (an unsubscribe made there, or a message it dropped for a listed address).
 */
export type EmailEvent = {
  kind: "spam_report" | "bounce" | "suppressed";
  /** Trimmed and lowercased. */
  email: string;
  at: Date;
};

/** `not_configured`: no usable key. `signature`: the call is not SendGrid's. `body`: signed, but not an event array. */
export type EventReading =
  | { ok: true; events: EmailEvent[] }
  | { ok: false; reason: "not_configured" | "signature" | "body" };

export type EventReaderConfig = {
  /** The webhook's verification key from SendGrid: PEM, or the Base64 of its DER as the dashboard shows it. */
  publicKey: string | undefined;
  /** Receives one line when the key is unusable. Never an address or the body. */
  log?: (line: string) => void;
};

export type EventReader = {
  /**
   * Verifies the call, then turns its events into the kinds above. An event it cannot use (another kind,
   * an unreadable shape, a date no record can hold or one ahead of `now`) is left out and the rest of the
   * batch is read: one odd element must not cost the others theirs. Never throws.
   */
  read(rawBody: Uint8Array, headers: Headers, now?: Date): EventReading;
};

type Kind = EmailEvent["kind"];

// A bounce is permanent only with `type: "bounce"` (`blocked` is a temporary denial). A drop is SendGrid
// refusing to send to an address it already holds on a list of its own, for one of these reasons.
const DIRECT: Readonly<Record<string, Kind>> = {
  spamreport: "spam_report",
  unsubscribe: "suppressed",
  group_unsubscribe: "suppressed",
};
const DROP_REASONS: ReadonlySet<string> = new Set([
  "Bounced Address",
  "Invalid Address",
  "Spam Reporting Address",
  "Unsubscribed Address",
]);

// The last second a four-digit year holds. A store such as Firestore refuses a later date, on every
// delivery of the batch.
const LAST_SECOND = 253402300799;
// How far ahead of this server's clock an event may be dated. A later one would be the newest word on
// that address on every replay until its day came, whatever the person answered meanwhile.
const CLOCK_SKEW_SECONDS = 300;

function parseKey(value: string): KeyObject {
  return value.startsWith("-----")
    ? createPublicKey(value)
    : createPublicKey({
        key: Buffer.from(value, "base64"),
        format: "der",
        type: "spki",
      });
}

function verified(key: KeyObject, rawBody: Uint8Array, headers: Headers): boolean {
  const signature = headers.get(SIGNATURE_HEADER);
  const timestamp = headers.get(TIMESTAMP_HEADER);
  if (!signature || !timestamp) return false;
  try {
    return verify(
      "sha256",
      Buffer.concat([Buffer.from(timestamp), rawBody]),
      { key, dsaEncoding: "der" },
      Buffer.from(signature, "base64"),
    );
  } catch {
    return false;
  }
}

/** Unix seconds. SendGrid's reference types the field as a string, so digits in a string are read too. */
function seconds(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d{1,12}$/.test(value)) return Number(value);
  return null;
}

function kindOf(element: Record<string, unknown>): Kind | null {
  const { event } = element;
  if (typeof event !== "string") return null;
  // Own keys only: `DIRECT.constructor` exists on every object and is not an event.
  if (Object.hasOwn(DIRECT, event)) return DIRECT[event]!;
  if (event === "bounce") return element.type === "bounce" ? "bounce" : null;
  if (event === "dropped")
    return typeof element.reason === "string" && DROP_REASONS.has(element.reason)
      ? "suppressed"
      : null;
  return null;
}

function toEvent(raw: unknown, until: number): EmailEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const element = raw as Record<string, unknown>;
  if (typeof element.email !== "string") return null;
  const timestamp = seconds(element.timestamp);
  if (timestamp === null || !(timestamp > 0 && timestamp <= until)) return null;
  const kind = kindOf(element);
  if (!kind) return null;
  return {
    kind,
    email: element.email.trim().toLowerCase(),
    at: new Date(timestamp * 1000),
  };
}

export function createEventReader(config: EventReaderConfig): EventReader {
  const value = config.publicKey?.trim();
  // Parsed once: parsing costs on every call, and an unusable value would otherwise write one log line
  // per request from anybody.
  let key: KeyObject | null = null;
  if (value) {
    try {
      key = parseKey(value);
    } catch {
      config.log?.("[email] the event webhook's public key is unusable");
    }
  }

  function read(
    rawBody: Uint8Array,
    headers: Headers,
    now: Date = new Date(),
  ): EventReading {
    if (!key) return { ok: false, reason: "not_configured" };
    if (!verified(key, rawBody, headers))
      return { ok: false, reason: "signature" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(rawBody).toString("utf8"));
    } catch {
      return { ok: false, reason: "body" };
    }
    if (!Array.isArray(parsed)) return { ok: false, reason: "body" };
    const until = Math.min(
      LAST_SECOND,
      Math.floor(now.getTime() / 1000) + CLOCK_SKEW_SECONDS,
    );
    return { ok: true, events: parsed.flatMap((e) => toEvent(e, until) ?? []) };
  }

  return { read };
}
