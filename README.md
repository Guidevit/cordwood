# cordwood

Every app built on Next.js and Firebase rewrites the same parts: sign-in, billing, e-mail. cordwood keeps each of them as one npm package, so a new project installs it and writes only what is its own.

Cordwood is firewood cut to length and stacked, ready for the fire.

## Packages

| Package | What it does | Runtime dependencies |
|---|---|---|
| [`@cordwood/email`](packages/email) | Sends one e-mail through SendGrid's v3 Mail Send and reads its signed event webhook. | none |
| [`@cordwood/firebase`](packages/firebase) | Gives the server one firebase-admin app, the document each tenant's data lives under, and a command that merges the indexes your packages need. | `firebase-admin` (peer) |
| [`@cordwood/auth`](packages/auth) | Session cookies, roles the app defines, and tenant members: admit, change a role, remove. | `@cordwood/firebase`, `firebase-admin` (peer) |
| [`@cordwood/analytics`](packages/analytics) | A product-event log that holds ids only and counts a repeat once, with DAU, WAU, MAU and stickiness. | `firebase-admin` (peer) |
| [`@cordwood/surveys`](packages/surveys) | In-app NPS, CSAT and CES: when each is due, answers stored without a name, and the three scores. | `@cordwood/firebase`, `firebase-admin` (peer) |
| [`@cordwood/changelog`](packages/changelog) | Release notes: who has read the newest one, who asked for them by e-mail, and one message per person per release. | `@cordwood/firebase`, `firebase-admin` (peer) |
| [`@cordwood/experiments`](packages/experiments) | A/B tests: a stable arm per visitor, exposures and conversions counted once, and each arm compared with the control. | `firebase-admin` (peer) |
| [`@cordwood/tour`](packages/tour) | Guided tours: which each person has seen, and a headless controller that opens and walks the steps. | `@cordwood/firebase`, `firebase-admin` (peer), `react` (optional peer) |
| [`@cordwood/billing`](packages/billing) | Stripe subscriptions per tenant: Checkout, the customer portal, a verified webhook and the subscription mirrored in Firestore. | `@cordwood/firebase`, `firebase-admin` and `stripe` (peers) |

Each is on npm, under the `@cordwood` scope.

## Components

The packages draw nothing. For the screens they leave to you, [`registry/`](registry) holds six React components that install the shadcn/ui way, as source copied into your app: the tour's card, the survey question, the release notes dialog, the unsubscribe page, the subscription card and the members table.

```bash
npx shadcn add @cordwood/tour-card
```

They use your app's own `Button`, `Dialog` and colours, and every word they show comes in through a `labels` prop. [Set the registry up](registry/README.md#install) once per app.

## Start a new app with one prompt

Open Claude Code in an empty folder and paste this. There is nothing to fill in.

```text
Set up a new app on cordwood in this folder.

1. Get the cordwood skills. Clone https://github.com/Guidevit/cordwood into
   ~/.cordwood/repo, or run `git pull --ff-only` there if it already exists.
2. Install the plugin for later sessions: run
   `claude plugin marketplace add Guidevit/cordwood` and then
   `claude plugin install cordwood@cordwood`. If either fails, tell me in one
   line and carry on.
3. Read ~/.cordwood/repo/plugin/skills/new-app/SKILL.md and follow it from
   step 1 to step 8, without skipping the walk in step 6. Where it names
   another skill or a reference file, read it from
   ~/.cordwood/repo/plugin/skills/.
4. When a package or a skill turns out to be wrong or missing something,
   follow ~/.cordwood/repo/plugin/skills/improve/SKILL.md.

Do not ask me what the product is before the base runs, and do not ask me to
confirm the stack or the pages. Name the app after this folder. Leave the app
running, tell me the address, and then ask me what I want to build.
```

Claude builds the base, runs it on the Firebase emulators, walks sign-up and invites in the browser, and then asks what you want to build. The screens come in the language you write to Claude in, so add a line to the prompt in your own language if that is not English. You need Node 22, pnpm and Java 21 on the machine. No cloud account or key is needed to start.

## Claude Code skill

The repository is also a Claude Code plugin with three skills. Install it once:

```
/plugin install cordwood --marketplace Guidevit/cordwood
```

**`new-app`** starts a product from an empty folder. With the plugin installed, run it there, with or without an idea after it:

```
/cordwood:new-app
```

Claude scaffolds a Next.js app, wires the 9 packages and 6 components, and runs it on the Firebase emulators, with no cloud account or key. It walks sign-up, invites and sign-out in the browser before it says the base works. Then it asks for your idea, if you have not given it, and has you confirm the data model for the first feature.

**`cordwood`** is for an app that already exists. It loads on a request such as "add Stripe subscriptions" or "invite members by e-mail", and sends Claude to install the package and read its README before writing code.

**`improve`** runs when Claude meets a bug in a package, something missing that any app would need, or a wrong instruction in a skill. It fixes the cause in this repository with a test and pushes it. With write access it also merges the release, so the fix is on npm minutes later. Without it, Claude opens a pull request.

To use the skills without the plugin, copy the folders in [`plugin/skills`](plugin/skills) into your project's `.claude/skills/`.

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
pnpm test        # 522 tests, inside the Auth and Firestore emulators
pnpm test:unit   # the 338 that need no emulator, in about a second
pnpm test:stripe # billing against a real Stripe sandbox, see below
pnpm typecheck
```

`pnpm test:stripe` needs a file named `.env` at the root with `STRIPE_SECRET_KEY` set to a test-mode key of a sandbox you can fill with test objects. Git ignores that file. The suite refuses a live key.

Build before the first type-check: a package reads the types of the packages it depends on from their `dist`.

A change to a package ships with a changeset. Run `pnpm changeset`, pick the package and the bump, and commit the file it writes.

## License

MIT. Open an issue before a large pull request, so the package's boundary is agreed first.
