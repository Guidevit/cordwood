import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  EmailNotConfigured,
  EmailNotSent,
  InvalidHeader,
  failureStatus,
  isSenderRefusal,
} from "./errors.js";
import { createEmailSender, type EmailConfig } from "./send.js";

// A stand-in for SendGrid on this machine: it records what arrived and answers what the test set.
type Received = { path: string; authorization: string | undefined; body: any };
let server: Server;
let baseUrl: string;
let received: Received[] = [];
let answer: { status: number; body?: string; location?: string } = { status: 202 };

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received.push({
        path: req.url ?? "",
        authorization: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      if (answer.location) res.setHeader("location", answer.location);
      res.statusCode = answer.status;
      res.end(answer.body ?? "");
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((done) => server.close(() => done())));

beforeEach(() => {
  received = [];
  answer = { status: 202 };
});

function sender(overrides: Partial<EmailConfig> = {}, lines: string[] = []) {
  return createEmailSender({
    apiKey: "SG.test-key",
    from: { email: "no-reply@example.com", name: "Example" },
    baseUrl,
    log: (line) => lines.push(line),
    ...overrides,
  });
}

const message = { to: "ana@example.org", subject: "Welcome", text: "Hello." };

describe("a transactional message", () => {
  it("is one POST to /v3/mail/send with the bearer key", async () => {
    await sender().send(message);
    expect(received).toHaveLength(1);
    expect(received[0]!.path).toBe("/v3/mail/send");
    expect(received[0]!.authorization).toBe("Bearer SG.test-key");
  });

  it("carries the recipient, the sender, the subject and the plain text", async () => {
    await sender().send(message);
    const { body } = received[0]!;
    expect(body.personalizations).toEqual([{ to: [{ email: "ana@example.org" }] }]);
    expect(body.from).toEqual({ email: "no-reply@example.com", name: "Example" });
    expect(body.subject).toBe("Welcome");
    expect(body.content).toEqual([{ type: "text/plain", value: "Hello." }]);
  });

  it("puts the html part after the plain one", async () => {
    await sender().send({ ...message, html: "<p>Hello.</p>" });
    expect(received[0]!.body.content).toEqual([
      { type: "text/plain", value: "Hello." },
      { type: "text/html", value: "<p>Hello.</p>" },
    ]);
  });

  it("turns click and open tracking off", async () => {
    await sender().send(message);
    expect(received[0]!.body.tracking_settings).toEqual({
      click_tracking: { enable: false, enable_text: false },
      open_tracking: { enable: false },
    });
  });

  it("bypasses the account's unsubscribe list", async () => {
    await sender().send(message);
    expect(received[0]!.body.mail_settings).toEqual({
      bypass_unsubscribe_management: { enable: true },
    });
  });

  it("sends its own headers, the reply address and a name for this message", async () => {
    await sender().send({
      ...message,
      headers: { "List-Unsubscribe": "<https://example.com/out?c=1>" },
      replyTo: "office@example.net",
      fromName: "  Acme Office ",
    });
    const { body } = received[0]!;
    expect(body.headers).toEqual({ "List-Unsubscribe": "<https://example.com/out?c=1>" });
    expect(body.reply_to).toEqual({ email: "office@example.net" });
    expect(body.from).toEqual({ email: "no-reply@example.com", name: "Acme Office" });
  });

  it("leaves the name out when the sender has none", async () => {
    await sender({ from: { email: "no-reply@example.com" } }).send(message);
    expect(received[0]!.body.from).toEqual({ email: "no-reply@example.com" });
  });
});

describe("a subscribed message", () => {
  const config = { subscriptionFrom: { email: "news@example.com", name: "Example News" } };

  it("leaves from the subscription sender, without the unsubscribe bypass", async () => {
    await sender(config).send({ ...message, subscription: true });
    const { body } = received[0]!;
    expect(body.from).toEqual({ email: "news@example.com", name: "Example News" });
    expect(body.mail_settings).toBeUndefined();
  });

  it("never falls back to the transactional sender", async () => {
    const lines: string[] = [];
    await expect(
      sender({}, lines).send({ ...message, subscription: true }),
    ).rejects.toBeInstanceOf(EmailNotConfigured);
    expect(received).toHaveLength(0);
    expect(lines).toEqual(["[email] no e-mail leaves this server: subscriptionFrom missing"]);
  });

  it("is refused when its sender is not an address", async () => {
    await expect(
      sender({ subscriptionFrom: { email: "Example News" } }).send({
        ...message,
        subscription: true,
      }),
    ).rejects.toThrow("subscriptionFrom is not an address");
    expect(received).toHaveLength(0);
  });
});

describe("a sender that is not configured", () => {
  it.each([
    ["apiKey missing", { apiKey: undefined }],
    ["apiKey missing", { apiKey: "   " }],
    ["from missing", { from: undefined }],
    ["from is not an address", { from: { email: "not-an-address" } }],
    ["baseUrl is not a loopback http address", { baseUrl: "https://evil.example.com" }],
    ["baseUrl is not a loopback http address", { baseUrl: "https://127.0.0.1:1" }],
    ["baseUrl is not a loopback http address", { baseUrl: "not a url" }],
  ] satisfies [string, Partial<EmailConfig>][])("throws and logs '%s'", async (reason, overrides) => {
    const lines: string[] = [];
    const sending = sender(overrides, lines).send(message);
    await expect(sending).rejects.toBeInstanceOf(EmailNotConfigured);
    await expect(sending).rejects.toThrow(reason);
    expect(lines).toEqual([`[email] no e-mail leaves this server: ${reason}`]);
    expect(received).toHaveLength(0);
  });
});

describe("a header that cannot go out", () => {
  it.each([
    ["a name with a colon", { headers: { "X:Bad": "v" } }],
    ["a value with a line break", { headers: { "X-Ok": "a\r\nBcc: x@example.com" } }],
    ["an empty value", { headers: { "X-Ok": "" } }],
    ["a sender name with a line break", { fromName: "Acme\nBcc: x@example.com" }],
    ["a sender name past 120 characters", { fromName: "a".repeat(121) }],
    ["an empty reply address", { replyTo: "  " }],
  ])("refuses %s before any request", async (_case, extra) => {
    await expect(sender().send({ ...message, ...extra })).rejects.toBeInstanceOf(InvalidHeader);
    expect(received).toHaveLength(0);
  });
});

describe("a failed send", () => {
  it("throws the status and logs the field names only", async () => {
    answer = {
      status: 400,
      body: JSON.stringify({
        errors: [{ message: "ana@example.org is not valid", field: "personalizations.0.to" }],
      }),
    };
    const lines: string[] = [];
    const error = await sender({}, lines).send(message).catch((e) => e);
    expect(error).toBeInstanceOf(EmailNotSent);
    expect(error.status).toBe(400);
    expect(lines).toEqual([
      "[email] SendGrid refused the message: HTTP 400 (personalizations.0.to)",
    ]);
    expect(lines.join()).not.toContain("ana@example.org");
  });

  it("logs a body it cannot read as such", async () => {
    answer = { status: 500, body: "<html>oops</html>" };
    const lines: string[] = [];
    await expect(sender({}, lines).send(message)).rejects.toBeInstanceOf(EmailNotSent);
    expect(lines).toEqual(["[email] SendGrid refused the message: HTTP 500 (unreadable body)"]);
  });

  it("reports an unreachable service with the system's reason", async () => {
    const lines: string[] = [];
    // A port that was just released: nothing listens there.
    const gone = createServer();
    await new Promise<void>((done) => gone.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${(gone.address() as AddressInfo).port}`;
    await new Promise<void>((done) => gone.close(() => done()));
    const error = await sender({ baseUrl: url }, lines)
      .send(message)
      .catch((e) => e);
    expect(error).toBeInstanceOf(EmailNotSent);
    expect(error.status).toBeNull();
    expect(lines).toEqual(["[email] SendGrid unreachable: ECONNREFUSED"]);
  });

  it("does not follow a redirect with the key", async () => {
    answer = { status: 307, location: `${baseUrl}/elsewhere` };
    const error = await sender().send(message).catch((e) => e);
    expect(error).toBeInstanceOf(EmailNotSent);
    expect(error.status).toBeNull();
    expect(received).toHaveLength(1);
  });

  it("gives up after the timeout", async () => {
    const slow = createServer(() => {});
    await new Promise<void>((done) => slow.listen(0, "127.0.0.1", done));
    const lines: string[] = [];
    const url = `http://127.0.0.1:${(slow.address() as AddressInfo).port}`;
    const error = await sender({ baseUrl: url, timeoutMs: 50 }, lines)
      .send(message)
      .catch((e) => e);
    slow.closeAllConnections();
    await new Promise<void>((done) => slow.close(() => done()));
    expect(error).toBeInstanceOf(EmailNotSent);
    expect(lines).toEqual(["[email] SendGrid unreachable: TimeoutError"]);
  });
});

describe("what a caller does with a failure", () => {
  it("answers 503 with no sender and 502 when SendGrid failed", () => {
    expect(failureStatus(new EmailNotConfigured("apiKey missing"))).toBe(503);
    expect(failureStatus(new EmailNotSent(400))).toBe(502);
  });

  it("stops a run on a refusal that is about the sender", () => {
    expect([401, 403, 429, 500, 503].every(isSenderRefusal)).toBe(true);
    expect([400, 413, null].some(isSenderRefusal)).toBe(false);
  });
});
