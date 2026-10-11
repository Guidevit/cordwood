# cordwood

Every app built on Next.js and Firebase rewrites the same parts: sign-in, billing, e-mail. cordwood keeps each of them as one npm package, so a new project installs it and writes only what is its own.

Cordwood is firewood cut to length and stacked, ready for the fire.

## Packages

| Package | What it does | Runtime dependencies |
|---|---|---|
| [`@cordwood/email`](packages/email) | Sends one e-mail through SendGrid's v3 Mail Send and reads its signed event webhook. | none |
| [`@cordwood/firebase`](packages/firebase) | Gives the server one firebase-admin app and the document each tenant's data lives under. | `firebase-admin` (peer) |
| [`@cordwood/auth`](packages/auth) | Session cookies, roles the app defines, and tenant members: admit, change a role, remove. | `@cordwood/firebase`, `firebase-admin` (peer) |

Version 0.1.0 of each is built and tested here. None is on npm yet.

Planned, in this order: `billing` (Stripe), `analytics`, `referral`, `surveys`, `changelog`, `experiments`, `tour`.

## What every package assumes

A package knows nothing about the app that installs it. It has no product name, no business rule and no text a user reads. Two conventions hold across all of them.

**The browser never opens Firestore.** Reads and writes go through the server with firebase-admin, and the client rules deny everything.

**A tenant's data lives under `tenants/{tenantId}`.** The id comes from a verified session. A request's body or query never names it.

A package also reads no environment variable. The app passes each key in, which keeps every secret's source in one place: your code.

## Work on it

You need Node 22 or later, pnpm 10 and Java 21 or later. The Firebase emulators run on Java.

```bash
pnpm install
pnpm build
pnpm test        # 140 tests, inside the Auth and Firestore emulators
pnpm test:unit   # the 95 that need no emulator, in about a second
pnpm typecheck
```

Build before the first type-check: a package reads the types of the packages it depends on from their `dist`.

A change to a package ships with a changeset. Run `pnpm changeset`, pick the package and the bump, and commit the file it writes.

## License

MIT. Open an issue before a large pull request, so the package's boundary is agreed first.
