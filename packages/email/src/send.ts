// One e-mail through SendGrid's v3 Mail Send. A plain `fetch`: the request is one JSON POST with a
// bearer key, and `@sendgrid/mail` would add a dependency to build the same object.
import { EmailNotConfigured, EmailNotSent, InvalidHeader } from "./errors.js";

const SENDGRID = "https://api.sendgrid.com";
const PATH = "/v3/mail/send";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_NAME_LENGTH = 120;

/** A sending address and the name an inbox shows beside it. */
export type Sender = { email: string; name?: string };

export type EmailConfig = {
  /** SendGrid API key. Read it from the environment or a secret manager, never from source. */
  apiKey: string | undefined;
  /** Who transactional messages come from. */
  from: Sender | undefined;
  /** Who subscribed messages come from. They never fall back to `from`. */
  subscriptionFrom?: Sender;
  /**
   * A stub of the API on this machine, for a local run without the real key. Only a loopback http
   * origin is taken, so the option cannot carry a key to another host.
   */
  baseUrl?: string;
  /** How long one request may take. Default 10 s. */
  timeoutMs?: number;
  /** Receives one line per failure: a status and field names, never a recipient, the text or the key. */
  log?: (line: string) => void;
};

/**
 * One message to one address. The text part is always there, and `html` adds a second part beside it.
 * `subscription` says the person subscribed to this message (a newsletter, release notes): it leaves from
 * `subscriptionFrom` and SendGrid's unsubscribe list holds for it. Everything else is transactional.
 */
export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  headers?: Readonly<Record<string, string>>;
  /** Replaces the sender's name for this message. The sending address never changes. */
  fromName?: string;
  replyTo?: string;
  subscription?: true;
};

export type EmailSender = {
  /** Sends `message`. Throws `EmailNotConfigured`, `InvalidHeader` or `EmailNotSent`, and nothing is sent then. */
  send(message: EmailMessage): Promise<void>;
};

// RFC 5322's field name: printable ASCII without the colon. A value takes anything but a control
// character, so a URL handed in as a header's value cannot start a second header with a line break.
const HEADER_NAME = /^[!-9;-~]+$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
// Deliberately loose: SendGrid is the judge of an address. This only tells an address from a typo'd variable.
const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function headerValue(value: string, max = Infinity): string {
  const clean = value.trim();
  if (!clean || CONTROL.test(clean) || clean.length > max)
    throw new InvalidHeader("invalid header value");
  return clean;
}

function ownHeaders(message: EmailMessage): Record<string, string> | undefined {
  const pairs = Object.entries(message.headers ?? {});
  for (const [name, value] of pairs)
    if (!HEADER_NAME.test(name) || value === "" || CONTROL.test(value))
      throw new InvalidHeader("invalid header");
  return pairs.length ? Object.fromEntries(pairs) : undefined;
}

function body(message: EmailMessage, sender: Sender) {
  const headers = ownHeaders(message);
  const name =
    message.fromName === undefined
      ? sender.name
      : headerValue(message.fromName, MAX_NAME_LENGTH);
  const replyTo =
    message.replyTo === undefined ? null : headerValue(message.replyTo);
  return {
    personalizations: [{ to: [{ email: message.to }] }],
    from: { email: sender.email, ...(name ? { name } : {}) },
    ...(replyTo ? { reply_to: { email: replyTo } } : {}),
    subject: message.subject,
    // The plain part first: a client shows the last part it can render, and a filter reads both.
    content: [
      { type: "text/plain", value: message.text },
      ...(message.html ? [{ type: "text/html", value: message.html }] : []),
    ],
    ...(headers ? { headers } : {}),
    // These messages often carry a one-time link: a tracking redirect would pass its code through
    // SendGrid's host, and a gateway that opens links would open the redirect.
    tracking_settings: {
      click_tracking: { enable: false, enable_text: false },
      open_tracking: { enable: false },
    },
    // A transactional message (an invite, a password reset) must not be dropped by the account's global
    // unsubscribe list. SendGrid still suppresses bounces and spam reports with this set. A subscribed
    // message is the opposite case: the list is the person's to use, so it goes out without the bypass.
    ...(message.subscription
      ? {}
      : { mail_settings: { bypass_unsubscribe_management: { enable: true } } }),
  };
}

/**
 * Why a request never reached SendGrid. Node reports every network failure as `TypeError: fetch failed`
 * and keeps the reason on `cause.code` (ECONNREFUSED, ENOTFOUND). Only a value shaped like a system code
 * is logged, since a cause is whatever was thrown. Anything else falls back to the error's name.
 */
function networkReason(error: unknown): string {
  const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]{2,40}$/.test(code))
    return code;
  return (error as Error | null)?.name ?? "error";
}

/** The fields SendGrid's error body names, never its messages: one can quote the address it refused. */
async function errorFields(response: Response): Promise<string> {
  try {
    const { errors } = (await response.json()) as {
      errors?: { field?: string | null }[];
    };
    const fields = (errors ?? []).map((e) => e.field ?? "no field");
    return fields.length ? fields.join(", ") : "no errors in body";
  } catch {
    return "unreadable body";
  }
}

export function createEmailSender(config: EmailConfig): EmailSender {
  const log = config.log ?? (() => {});

  // Logged before it is thrown: every send fails the same way until the deployment changes, and a 503
  // alone shows the operator nothing. `reason` names the option, never its value.
  function notConfigured(reason: string): EmailNotConfigured {
    log(`[email] no e-mail leaves this server: ${reason}`);
    return new EmailNotConfigured(reason);
  }

  function senderFor(message: EmailMessage): Sender {
    const option = message.subscription ? "subscriptionFrom" : "from";
    const sender = config[option];
    const email = sender?.email.trim();
    if (!email) throw notConfigured(`${option} missing`);
    // An unusable address makes SendGrid refuse every message with a 400, which a run over many
    // recipients would take for each person's own failure.
    if (!ADDRESS.test(email)) throw notConfigured(`${option} is not an address`);
    return { email, name: sender?.name?.trim() || undefined };
  }

  function origin(): string {
    const local = config.baseUrl?.trim();
    if (!local) return SENDGRID;
    let url: URL | null = null;
    try {
      url = new URL(local);
    } catch {}
    if (url?.protocol !== "http:" || !LOOPBACK.has(url.hostname))
      throw notConfigured("baseUrl is not a loopback http address");
    return url.origin;
  }

  async function send(message: EmailMessage): Promise<void> {
    const apiKey = config.apiKey?.trim();
    if (!apiKey) throw notConfigured("apiKey missing");
    const sender = senderFor(message);
    const url = `${origin()}${PATH}`;
    const request = JSON.stringify(body(message, sender));
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: request,
        // A redirect is a refusal: the key must never follow one to another host.
        redirect: "error",
        signal: AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (error) {
      log(`[email] SendGrid unreachable: ${networkReason(error)}`);
      throw new EmailNotSent(null);
    }
    if (response.ok) return;
    log(
      `[email] SendGrid refused the message: HTTP ${response.status} (${await errorFields(response)})`,
    );
    throw new EmailNotSent(response.status);
  }

  return { send };
}
