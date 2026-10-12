---
name: cordwood
description: Use when an app needs sign-in and sessions, roles or team members, Stripe subscriptions, transactional e-mail, product analytics (DAU, MAU), NPS, CSAT or CES surveys, release notes or a changelog, A/B tests, or a guided product tour, in a Next.js app on Firebase, or when the code already imports from @cordwood. Also when the request is in Portuguese (login, assinatura, pagamento, convite de membros, pesquisa de satisfação, novidades, teste A/B, tour guiado). Wires the published @cordwood packages and shadcn components instead of writing these features by hand.
---

# Cordwood

Nine npm packages and six shadcn components cover the parts every SaaS rebuilds: auth, billing, e-mail, analytics, surveys, release notes, experiments and tours. Install them. Do not write a session cookie, a Stripe webhook or an NPS rule by hand in a project that can use these.

Starting from an empty folder? Use the `new-app` skill, which builds a running base from all of these and then comes back here.

## Check the fit first

The packages assume all four of these. Say so and stop if the project breaks one.

- Next.js App Router, on Node 22 or later.
- Firebase, reached from the server with `firebase-admin`. The browser never opens Firestore, and the client rules deny everything.
- Each customer is a tenant, and its data lives under `tenants/{tenantId}`.
- For the components: shadcn/ui with Tailwind.

## Pick

| The app needs | Package | Component |
|---|---|---|
| The admin app, a tenant's document, Firestore indexes | `@cordwood/firebase` | |
| Sign-in, session cookie, roles, inviting and removing members | `@cordwood/auth` | `members-table` |
| Stripe subscriptions per tenant | `@cordwood/billing` | `subscription-card` |
| Sending e-mail through SendGrid, reading bounces and complaints | `@cordwood/email` | |
| Product events, DAU, WAU, MAU, stickiness | `@cordwood/analytics` | |
| NPS, CSAT, CES inside the app | `@cordwood/surveys` | `survey-prompt` |
| Release notes in the app and by e-mail | `@cordwood/changelog` | `changelog-dialog`, `unsubscribe-card` |
| A/B tests on a page or a screen | `@cordwood/experiments` | |
| A guided tour of a screen | `@cordwood/tour` | `tour-card` |

`@cordwood/firebase` comes first: most of the others take its `firestore()` and `auth()`. `@cordwood/auth` comes second, since every other route needs `access.tenantId` from it.

## How to work

1. Read `package.json` to see which `@cordwood/*` packages are already there, and search the code for an existing `createAuth`, `createBilling` or similar. Reuse that instance.
2. Install what is missing with the project's package manager. Each package's README names its peers (`firebase-admin`, `stripe`).
3. **Read `node_modules/@cordwood/<name>/README.md` before writing a line that calls the package.** It is the reference for the installed version: every option, every return value, every error. This skill is only the map. Do not write a function name from memory.
4. Create one module per package under the project's server code (`src/server/` or `src/lib/`, whichever the project uses) that builds the instance and exports it. See [references/wiring.md](references/wiring.md) for each package's module and the routes it needs.
5. After adding a package that queries, merge its indexes: `pnpm exec cordwood-firebase indexes`, then `firebase deploy --only firestore:indexes`. Ask before deploying.
6. For a component, follow [references/components.md](references/components.md).

## Rules that hold in every package

- **The tenant comes from the session.** Use `access.tenantId` from `cordwood.access.require(request, permission)`. Never read a tenant id from a body, a query or a header.
- **Guard every route.** Each route handler starts with `access.require` and returns `access.status` when it fails. The exceptions are the public ones: sign-in, the Stripe and SendGrid webhooks, and the unsubscribe routes.
- **Server only.** Import a `@cordwood/*` package in route handlers, server actions and server components. The one browser import is `@cordwood/tour/react`. A client component reaches the rest through a route.
- **Keys are passed in.** No package reads an environment variable. Read `process.env` in the module that builds the instance, and add each new variable to the project's `.env.example`.
- **Origins come from configuration.** `origin` in billing and changelog is the deployment's own address. Never build it from a request's Host header.
- **Webhooks get the raw body.** Pass the bytes as they arrived (`request.arrayBuffer()`). A body parsed and serialised again does not verify.
- **Recording never blocks the act.** `analytics.record`, `experiments.expose` and `experiments.convert` cannot throw. Do not wrap them in try/catch, and do not make a response wait on their answer.
- **Do not edit `node_modules`** and do not copy a package's source into the app. If a package lacks something, write it beside the package and say what was missing.

## What the packages leave to the app

Tell the user when the request lands on one of these. None of them is a setting you missed.

- The browser side of sign-in. The app signs in with the Firebase client SDK and posts the ID token to a route that calls `sessions.exchange`.
- Platform operators who see across tenants. `auth` knows tenant members only.
- Creating Stripe products and prices. `billing` finds a price by its lookup key.
- Every sentence a user reads. E-mail bodies, survey questions and component labels are written in the app, in its language.
- Where a survey prompt or a tour appears on screen.

## When cordwood itself is the problem

A package bug, a missing capability any app would need, a README that sent you to a wrong call, or a step this skill got wrong: use the `improve` skill. It fixes the cause in the cordwood repository and pushes it. Do not leave a silent workaround in the app.

## Common mistakes

| Mistake | Instead |
|---|---|
| Calling Stripe to check whether a tenant pays | Read `billing.subscription(tenantId)`, the copy the webhook keeps |
| A new `initializeApp` beside `@cordwood/firebase` | `firestore()` and `auth()` from `@cordwood/firebase` |
| Role checks written as `if (role === "admin")` | Permissions in `defineRoles`, checked by `access.require(request, "members.manage")` |
| Calling `surveys.ask` on every page load to "peek" | Call it once, when about to show the question: it records the survey as shown |
| Reusing an experiment's id for a new round | A new id, since the id is what the split is cut with |
| Reading an A/B result before `reached` is true | Wait, and check `split.mismatch` first |
| A hand-written popover for the tour | `npx shadcn add @cordwood/tour-card` |
| English labels in a Portuguese app | Write every `labels` entry in the app's language |
