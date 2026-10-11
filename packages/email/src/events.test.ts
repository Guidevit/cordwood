import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createEventReader } from "./events.js";

const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
const derBase64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");

const NOW = new Date("2026-10-11T12:00:00Z");
const T = Math.floor(NOW.getTime() / 1000) - 60;

/** A delivery signed the way SendGrid signs: ECDSA over `timestamp + raw body`, DER, Base64. */
function delivery(payload: unknown, key = privateKey) {
  const rawBody = Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload));
  const timestamp = String(T);
  const signature = sign("sha256", Buffer.concat([Buffer.from(timestamp), rawBody]), {
    key,
    dsaEncoding: "der",
  }).toString("base64");
  const headers = new Headers({
    "X-Twilio-Email-Event-Webhook-Signature": signature,
    "X-Twilio-Email-Event-Webhook-Timestamp": timestamp,
  });
  return { rawBody, headers };
}

function read(payload: unknown) {
  const { rawBody, headers } = delivery(payload);
  return createEventReader({ publicKey: pem }).read(rawBody, headers, NOW);
}

describe("the signature", () => {
  const events = [{ event: "spamreport", email: "ana@example.org", timestamp: T }];

  it.each([
    ["PEM", pem],
    ["the Base64 DER the dashboard shows", derBase64],
  ])("verifies with the key as %s", (_form, key) => {
    const { rawBody, headers } = delivery(events);
    const reading = createEventReader({ publicKey: key }).read(rawBody, headers, NOW);
    expect(reading).toEqual({
      ok: true,
      events: [{ kind: "spam_report", email: "ana@example.org", at: new Date(T * 1000) }],
    });
  });

  it("refuses a body changed after it was signed", () => {
    const { headers } = delivery(events);
    const other = Buffer.from(JSON.stringify([{ ...events[0], email: "bob@example.org" }]));
    expect(createEventReader({ publicKey: pem }).read(other, headers, NOW)).toEqual({
      ok: false,
      reason: "signature",
    });
  });

  it("refuses a delivery signed by another key", () => {
    const stranger = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
    const { rawBody, headers } = delivery(events, stranger);
    expect(createEventReader({ publicKey: pem }).read(rawBody, headers, NOW)).toEqual({
      ok: false,
      reason: "signature",
    });
  });

  it.each([
    ["no headers", new Headers()],
    [
      "a signature that is not one",
      new Headers({
        "X-Twilio-Email-Event-Webhook-Signature": "not-a-signature",
        "X-Twilio-Email-Event-Webhook-Timestamp": String(T),
      }),
    ],
  ])("refuses %s", (_case, headers) => {
    const { rawBody } = delivery(events);
    expect(createEventReader({ publicKey: pem }).read(rawBody, headers, NOW)).toEqual({
      ok: false,
      reason: "signature",
    });
  });
});

describe("the key", () => {
  it.each([undefined, "", "   "])("answers not_configured for %j, silently", (key) => {
    const lines: string[] = [];
    const { rawBody, headers } = delivery([]);
    const reader = createEventReader({ publicKey: key, log: (l) => lines.push(l) });
    expect(reader.read(rawBody, headers, NOW)).toEqual({ ok: false, reason: "not_configured" });
    expect(lines).toEqual([]);
  });

  it("logs an unusable key once, not per delivery", () => {
    const lines: string[] = [];
    const { rawBody, headers } = delivery([]);
    const reader = createEventReader({ publicKey: "bm90IGEga2V5", log: (l) => lines.push(l) });
    reader.read(rawBody, headers, NOW);
    reader.read(rawBody, headers, NOW);
    expect(reader.read(rawBody, headers, NOW)).toEqual({ ok: false, reason: "not_configured" });
    expect(lines).toEqual(["[email] the event webhook's public key is unusable"]);
  });
});

describe("the body", () => {
  it.each([
    ["text that is not JSON", "not json"],
    ["an object", { event: "bounce" }],
  ])("answers body for %s, though signed", (_case, payload) => {
    expect(read(payload)).toEqual({ ok: false, reason: "body" });
  });
});

describe("the events", () => {
  const kinds = (payload: unknown[]) => {
    const reading = read(payload);
    if (!reading.ok) throw new Error(reading.reason);
    return reading.events.map((e) => e.kind);
  };
  const base = { email: "ana@example.org", timestamp: T };

  it("reads a spam report, a permanent bounce and the provider's own lists", () => {
    expect(
      kinds([
        { ...base, event: "spamreport" },
        { ...base, event: "bounce", type: "bounce" },
        { ...base, event: "unsubscribe" },
        { ...base, event: "group_unsubscribe" },
        { ...base, event: "dropped", reason: "Bounced Address" },
        { ...base, event: "dropped", reason: "Unsubscribed Address" },
      ]),
    ).toEqual(["spam_report", "bounce", "suppressed", "suppressed", "suppressed", "suppressed"]);
  });

  it("leaves out what nobody acts on", () => {
    expect(
      kinds([
        { ...base, event: "delivered" },
        { ...base, event: "open" },
        { ...base, event: "bounce", type: "blocked" },
        { ...base, event: "dropped", reason: "Spam Content" },
        { ...base, event: "constructor" },
      ]),
    ).toEqual([]);
  });

  it("skips an odd element and reads the rest of the batch", () => {
    expect(
      kinds([
        null,
        "spamreport",
        { event: "spamreport", timestamp: T },
        { ...base, event: "spamreport", timestamp: "soon" },
        { ...base, event: "spamreport", timestamp: 0 },
        { ...base, event: "bounce", type: "bounce" },
      ]),
    ).toEqual(["bounce"]);
  });

  it("reads a timestamp sent as digits in a string", () => {
    const reading = read([{ ...base, event: "spamreport", timestamp: String(T) }]);
    expect(reading).toMatchObject({ ok: true, events: [{ at: new Date(T * 1000) }] });
  });

  it("trims and lowercases the address", () => {
    const reading = read([{ event: "spamreport", email: "  Ana@Example.ORG ", timestamp: T }]);
    expect(reading).toMatchObject({ ok: true, events: [{ email: "ana@example.org" }] });
  });

  it("takes an event up to five minutes ahead of the clock, and none later", () => {
    const ahead = (s: number) => Math.floor(NOW.getTime() / 1000) + s;
    expect(
      kinds([
        { ...base, event: "spamreport", timestamp: ahead(300) },
        { ...base, event: "bounce", type: "bounce", timestamp: ahead(301) },
      ]),
    ).toEqual(["spam_report"]);
  });
});
