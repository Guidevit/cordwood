# @kindling/email

One e-mail through SendGrid's v3 Mail Send, with a single `fetch` and no runtime dependency. It also verifies SendGrid's signed Event Webhook and returns the events an app acts on.

```bash
pnpm add @kindling/email
```

Node 22 or later. Server only: the API key must never reach a browser bundle.

## Send

```ts
import { createEmailSender } from "@kindling/email";

export const email = createEmailSender({
  apiKey: process.env.SENDGRID_API_KEY,
  from: { email: "no-reply@example.com", name: "Example" },
  log: console.error,
});

await email.send({
  to: "ana@example.org",
  subject: "Your invite",
  text: "Open https://example.com/invite/abc to join.",
});
```

`send` resolves when SendGrid accepts the message and throws otherwise. Nothing is sent when it throws.

| Error | When | Answer a route with |
|---|---|---|
| `EmailNotConfigured` | The key or the sender is missing, or the sender is not an address. | 503 |
| `EmailNotSent` | SendGrid refused (`status` holds the code) or was unreachable (`status` is null). | 502 |
| `InvalidHeader` | A header, sender name or reply address carries a control character. | a bug to fix |

`failureStatus(error)` returns the 502 or 503 above. `isSenderRefusal(status)` is true for 401, 403, 429 and 5xx. Stop a bulk run on those, since the next recipient gets the same answer.

### What each message carries

- The plain text part always, and the `html` part after it when you pass one.
- Click and open tracking off. A tracking redirect would pass a one-time link through another host.
- A bypass of the account's unsubscribe list, so an invite or a password reset always leaves. SendGrid still holds back bounces and spam reports.

### Subscribed messages

A newsletter is the opposite case: the person may unsubscribe, and the list must hold. Mark the message and give it a sender of its own.

```ts
const email = createEmailSender({
  apiKey: process.env.SENDGRID_API_KEY,
  from: { email: "no-reply@example.com" },
  subscriptionFrom: { email: "news@example.com", name: "Example News" },
});

await email.send({ to, subject, text, subscription: true });
```

A subscribed message never falls back to `from`. Without `subscriptionFrom` it throws `EmailNotConfigured`.

### Logs

`log` receives one line per failure. A line holds a status and the field names SendGrid reported. It never holds the recipient, the text or the key.

### Local runs

`baseUrl` points the sender at a stub on your machine, for a run without the real key. Only a loopback http address is accepted (`127.0.0.1`, `localhost`, `[::1]`).

## Read the event webhook

SendGrid signs `timestamp + raw body`. Verify on the bytes as they arrived, before parsing.

```ts
import { createEventReader } from "@kindling/email";

const events = createEventReader({
  publicKey: process.env.SENDGRID_WEBHOOK_PUBLIC_KEY,
});

export async function POST(request: Request) {
  const raw = new Uint8Array(await request.arrayBuffer());
  const reading = events.read(raw, request.headers);
  if (!reading.ok) {
    return new Response(null, { status: reading.reason === "body" ? 400 : 401 });
  }
  for (const event of reading.events) {
    // event.kind: "spam_report" | "bounce" | "suppressed"
    // event.email is trimmed and lowercased, event.at is a Date
  }
  return new Response(null, { status: 204 });
}
```

`publicKey` takes the PEM or the Base64 string the SendGrid dashboard shows. `read` never throws.

| `kind` | From SendGrid's |
|---|---|
| `spam_report` | `spamreport` |
| `bounce` | `bounce` with `type: "bounce"`. A `blocked` bounce is temporary and is left out. |
| `suppressed` | `unsubscribe`, `group_unsubscribe`, and `dropped` for an address already on one of SendGrid's lists |

Deliveries, opens and clicks are left out. So is any event dated more than five minutes ahead of your server's clock.
