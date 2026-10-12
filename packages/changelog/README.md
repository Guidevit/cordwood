# @cordwood/changelog

Release notes inside the app, and by e-mail for whoever asked. The package keeps who has read the newest release, who said yes to the e-mails, and sends each release once per person. You write the notes and the message.

```bash
pnpm add @cordwood/changelog @cordwood/firebase firebase-admin
```

Node 22 or later. Server only.

## Set up

```ts
import { createChangelog } from "@cordwood/changelog";
import { auth, firestore } from "@cordwood/firebase";

export const NOTES = [
  { version: "2.10.0", title: "Saved filters", body: "..." },
  { version: "2.9.0", title: "Dark theme", body: "..." },
];

export const changelog = createChangelog({
  firestore: firestore(),
  auth: auth(),
  notes: NOTES,
  origin: "https://app.example.com",
});
```

`notes` is your own list, newest first. Each entry needs a `version`, and the rest is whatever your screens show. Versions made of dotted numbers are compared as numbers, so 2.9.0 is older than 2.10.0.

`origin` is the app's address, written in config. Never read it from a request's Host header, since it goes into the links an e-mail carries.

## Inside the app

```ts
const { latest, unread } = await changelog.status(tenantId, userId);
await changelog.markRead(tenantId, userId);
```

Show a dot while `unread` is true, and call `markRead` when the person opens the notes. A build rolled back to the release before does not make them unread again.

## The yes and the no

```ts
await changelog.subscribe(tenantId, userId, true, "settings");
const { on, at } = await changelog.subscription(tenantId, userId);
```

The fourth argument says where the answer was given. It is stored beside the answer and its instant, as the record of the consent. A no is stored as a no.

A yes starts at the next release. Nobody receives, an hour after asking, the notes of a version that was already live.

## Send

Call `send` from a scheduled route, once a day or after each deploy.

```ts
import { createEmailSender } from "@cordwood/email";

const mail = createEmailSender({ apiKey, from, subscriptionFrom });

const result = await changelog.send(async ({ to, note, unsubscribeUrl, oneClickUrl }) => {
  await mail.send({
    to,
    subject: `New in ${note.version}: ${note.title}`,
    text: `${note.body}\n\nStop these e-mails: ${unsubscribeUrl}`,
    subscription: true,
    headers: {
      "List-Unsubscribe": `<${oneClickUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  });
});
// { version: "2.10.0", sent: 41, failed: 1 }
```

The run reads every tenant's subscribers and writes to each person who has not had this version. The address comes from Firebase Auth at that moment, and only a confirmed address of an open account receives anything.

Each person is marked before their message leaves. Two runs at the same moment send one message per person, and a crash can lose one message but never repeat it.

When a delivery throws, the run reads the error:

| The error | The run |
|---|---|
| The service refused this one message (a 400, say). | Counts it in `failed` and goes on. |
| Nothing can be sent: no key, 401, 403, 429, a 5xx. | Gives the person's mark back and throws `SendStopped`. |
| No answer came (`status` is null). | Keeps that one mark, since the message may have left, and throws `SendStopped`. |

A malformed sender makes the service refuse every message as if each were wrong. So refusals that arrive before any message was accepted are held. At the third, or at the end of a run with none accepted, every mark goes back and the run throws `SendStopped`. Fix the sender, run again, and everyone gets the release.

The table fits the errors of `@cordwood/email`. For another service, pass `classify: (error) => "message" | "sender" | "unknown"` in the second argument.

## Leaving by a link

Every message carries two links to the same 43-character code, which belongs to one person and never expires.

`unsubscribeUrl` opens a page of yours with the code after `#`, where no server log sees it. The page reads it and posts it to a route:

```ts
export async function POST(request: Request) {
  const { token } = await request.json();
  await changelog.unsubscribe(token);
  return new Response(null, { status: 204 });
}
```

`oneClickUrl` is for the `List-Unsubscribe` header. Gmail and other providers POST to it with the code in `?t=`:

```ts
export async function POST(request: Request) {
  await changelog.unsubscribe(new URL(request.url).searchParams.get("t"));
  return new Response(null, { status: 204 });
}
```

The defaults are `/changelog/unsubscribe` and `/api/changelog/unsubscribe`. Change them with `unsubscribePath` and `oneClickPath`.

`unsubscribe` can only turn the e-mails off. An unknown code, a used one and a mangled one all end the same way, with no error. Answer 204 every time, so a link tells nobody whether an address is on the list.

## Complaints and bounces

```ts
const reading = reader.read(rawBody, request.headers); // createEventReader, from @cordwood/email
if (reading.ok) await changelog.applyMailEvents(reading.events);
// { ended: 2 }
```

Each event is `{ email, at, kind? }`. It ends the e-mails of the person whose account holds that address, with `kind` stored as the source. An event older than the person's yes is skipped, so a batch delivered twice never undoes a later answer.

## When a person leaves

```ts
await changelog.forget(tenantId, userId);
```

It deletes their state and their code. Call it where you remove a member.

## The index

The run queries every tenant's `changelog_state` at once, which needs an index the package ships. Add it to your project with the command from `@cordwood/firebase`:

```bash
pnpm exec cordwood-firebase indexes
firebase deploy --only firestore:indexes
```

## Where it stores

| Path | Holds |
|---|---|
| `tenants/{tenantId}/changelog_state/{userId}` | The version the person last read, their answer about the e-mails with its instant and source, their code, and the last version sent. |
| `changelog_exits/{code}` | The tenant and person a code belongs to. |

No e-mail address is stored.
