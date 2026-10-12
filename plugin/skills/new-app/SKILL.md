---
name: new-app
description: Use when the user wants to start a new app, SaaS or product from an empty or nearly empty folder and has an idea but no code yet, in English or Portuguese ("create my app", "start a new project", "quero criar um app", "monta a base", "começar um SaaS"). Builds a running Next.js and Firebase base with sign-up, sign-in, team members, billing, release notes, surveys, a tour and analytics from the @cordwood packages, verifies it in the browser, and only then starts on the user's business rules.
argument-hint: [the app idea, in a sentence or a paragraph]
---

# New app on cordwood

The user has an idea and an empty folder. Your job has two halves, in this order: a base app that runs, then their business rules on top of it. Do not write a business rule before the base passes the walk in step 6.

The base is the part every SaaS shares, built from the `@cordwood` packages and components. It runs on the Firebase emulators, so it needs no cloud account, no Stripe key and no SendGrid key to start.

Load the `cordwood` skill too. Its rules and its `references/wiring.md` apply to everything you write here.

## 1. Read the request, ask almost nothing

Take from the user's message what the app is, what they call it, and the language its users read. If the message has no name, use the folder's name. If it has no language, use the language the user writes to you in.

Ask one question only when the folder is not empty and holds something that is not yours to overwrite. Everything else has a default below. The user said they want one command, so do not stop to confirm the stack, the folder layout or the page list.

Keep the idea itself for step 8. Do not let it shape the base.

## 2. Check the machine

Run these and stop with a plain explanation if one fails, naming what to install.

| Needs | Check | Why |
|---|---|---|
| Node 22 or later | `node -v` | The packages require it |
| pnpm | `pnpm -v` | `corepack enable pnpm` adds it |
| Java 21 or later | `java -version` | The Firebase emulators run on it |

## 3. Scaffold

Run in the target folder. Use `.` as the name when the folder is the project.

```bash
pnpm create next-app@latest . --ts --tailwind --eslint --app --src-dir --import-alias "@/*" --use-pnpm --yes
npx shadcn@latest init -d
```

Add the cordwood registry to `components.json` (see the `cordwood` skill's `references/components.md`), then:

```bash
npx shadcn@latest add input label card @cordwood/tour-card @cordwood/survey-prompt @cordwood/changelog-dialog @cordwood/unsubscribe-card @cordwood/subscription-card @cordwood/members-table
pnpm add @cordwood/firebase @cordwood/auth @cordwood/email @cordwood/billing @cordwood/analytics @cordwood/surveys @cordwood/changelog @cordwood/experiments @cordwood/tour firebase firebase-admin stripe
pnpm add -D firebase-tools
```

Then read the README of every `@cordwood` package in `node_modules`. They are short, and every call you write in step 5 comes from them.

## 4. Local Firebase

Create the files in [references/base-app.md](references/base-app.md#local-firebase): `firebase.json`, `.firebaserc`, `firestore.rules`, the env files, and the `dev` script that starts the emulators with the app inside them.

Run `pnpm exec cordwood-firebase indexes` to write `firestore.indexes.json`.

Create no cloud project, deploy nothing, and put no real key in any file. Real Firebase, Stripe and SendGrid come later, when the user asks to go live.

## 5. Build the base

Build what [references/base-app.md](references/base-app.md) lists, in its order: server modules, session routes, sign-up, sign-in, the app shell, then one feature at a time. Each feature is small because the package and the component do the work.

Write every user-facing sentence in the app's language. Run `pnpm exec tsc --noEmit` after each group of files and fix what it reports before moving on.

## 6. Run it and walk it

The base is done when a person can use it, not when it compiles.

1. `pnpm exec tsc --noEmit`, `pnpm lint` and `pnpm build` pass.
2. Start `pnpm dev` in the background and wait for both the emulators and Next to be ready.
3. Walk the flow in a browser if you have a browser tool. Without one, walk it with `curl` and the emulators' REST endpoints, and say that no one has seen the screens.

| Step | Pass when |
|---|---|
| Sign up with an e-mail and a company name | The dev screen shows the confirmation link |
| Open the link, set a name and a password | The dashboard opens, signed in |
| Reload the dashboard | Still signed in |
| Open the dashboard for the first time | The tour opens, and does not open again after it ends |
| Invite a second address from the members page | The dev screen shows the invite link |
| Open the invite link in a private window, set a password | The second person lands on the same tenant's dashboard |
| Change the second person's role, then remove them | Their next request is refused |
| Open the release notes | The unread dot goes away and stays away after a reload |
| Sign out | The dashboard redirects to sign-in |
| Request the dashboard with no cookie | Redirect to sign-in. An API route answers 401 |

Fix every failure before going on. A step you could not check is reported as not checked, never as passing.

## 7. Hand over

Leave the dev server running. Make the first commit (`git init` when there is no repository), with `.env.development` in and `.env.local` out.

Tell the user, briefly: the address to open, how to sign up, what works, what waits for a key (billing needs Stripe, real e-mail needs SendGrid), and which walk steps were not checked. Write the same into the project's `README.md`, with the `pnpm dev` command first.

## 8. Now the business rules

Go back to the idea from step 1. This is the part the user came for.

1. Say back, in three or four sentences, what you understood the product to do and for whom. Name the first thing a user would do in it.
2. Propose the data it needs as collections under `tenants/{tenantId}`, the permissions it adds to `defineRoles`, and the first screen. Keep it to what the first slice needs.
3. Ask the user to confirm or correct that, in one message. This is the one place to stop and listen: a wrong guess here costs more than a question.
4. Build the first slice end to end: a server module, guarded routes, a page in the shell. Then walk it in the browser as in step 6.

From here on the `cordwood` skill's rules hold for every feature. The tenant comes from the session, every route starts with `access.require`, and a feature a package already covers is wired, not rewritten. Add a product event to `defineEvents` for each act worth counting, and a tour step for each new screen worth explaining.

## When cordwood itself is the problem

A package bug, a missing capability any app would need, a README that sent you to a wrong call, or a step this skill got wrong: use the `improve` skill. It fixes the cause in the cordwood repository and pushes it. Do not leave a silent workaround in the app.

## Do not

- Do not start the business rules while a step of the walk fails.
- Do not replace a package with your own code because a call was hard to get right. Read its README again.
- Do not hard-code a tenant, a user or a secret to get past a step.
- Do not turn off the client rules that deny Firestore, even to debug.
- Do not ask the user for a Stripe or SendGrid key to finish the base. It runs without them.
