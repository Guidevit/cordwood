# The base app

What to build, in order. Each package's exact options and return values are in `node_modules/@cordwood/<name>/README.md`. This file says which files exist and how the flows fit together, including the parts no package covers.

`<app>` below is the project's name in lowercase with hyphens.

## Local Firebase

**`.firebaserc`**: default project `demo-<app>`. A project id that starts with `demo-` makes the emulators refuse to touch any real project.

**`firebase.json`**: the Auth emulator on 9099, Firestore on 8080, the emulator UI on, `firestore.rules` and `firestore.indexes.json` named.

**`firestore.rules`**: deny every client read and write. The `@cordwood/firebase` README has the lines.

**`package.json` scripts**

```json
{
  "dev": "firebase emulators:exec --only auth,firestore --ui --import=.emulator-data --export-on-exit=.emulator-data \"next dev\"",
  "indexes": "cordwood-firebase indexes"
}
```

`emulators:exec` sets `FIRESTORE_EMULATOR_HOST`, `FIREBASE_AUTH_EMULATOR_HOST` and `GCLOUD_PROJECT` for the command inside it, so firebase-admin reaches the emulators with no credentials. Add `.emulator-data` and `*-debug.log` to `.gitignore`.

**`.env.development`** is committed. It holds only values that are safe to publish:

```bash
APP_ORIGIN=http://localhost:3000
# Signs sign-up links on this machine. Production sets its own in the host's secrets.
APP_SECRET=dev-only-secret-change-me-0123456789abcdef
VISITOR_SECRET=dev-only-visitor-secret-0123456789abcdef
NEXT_PUBLIC_FIREBASE_API_KEY=demo-key
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=localhost
NEXT_PUBLIC_FIREBASE_PROJECT_ID=demo-<app>
NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR=http://127.0.0.1:9099
```

**`.env.example`** lists every variable the app reads, with the production ones empty: the four above plus `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE`, `SENDGRID_API_KEY`, `SENDGRID_WEBHOOK_PUBLIC_KEY`, `EMAIL_FROM`, `EMAIL_NEWS_FROM`, `CRON_SECRET`.

## Server modules

All under `src/server/`. Each starts with `import "server-only"`.

| File | Exports |
|---|---|
| `auth.ts` | `roles`, `cordwood` |
| `email.ts` | `email`, and `sendOrShow` |
| `billing.ts` | `billing`, or null when `STRIPE_SECRET_KEY` is unset |
| `analytics.ts` | `analytics` |
| `surveys.ts` | `surveys` |
| `changelog.ts` | `changelog` |
| `experiments.ts` | `experiments`, `visitors` |
| `tours.ts` | `tours` |
| `session.ts` | `currentSession()`, `requireSession()`, `setSessionCookie()`, `clearSessionCookie()` |
| `links.ts` | `signLink()`, `readLink()` |

**Roles.** Start with `owner` (everything, including `members.manage` and `billing.manage`), `admin` (the same without billing) and `member` (`app.read`, `app.write`). The business rules add permissions later.

**`sendOrShow(message, link)`.** With `SENDGRID_API_KEY` set, it sends the message and answers nothing. Without it, outside production, it sends nothing and answers the link, which the route passes to the page under a `devLink` field. The page shows it in a clearly marked dev box. In production with no key it throws. This is what lets the base run with no e-mail account.

**`session.ts`.** `currentSession()` reads the cookie with `cookies()` and calls `cordwood.sessions.read`. `requireSession()` redirects to `/sign-in` when there is none or it has no tenant. `setSessionCookie(cookie)` uses `cordwood.cookieName` and `cordwood.cookieOptions`, with one change: `secure` is true only in production. Safari drops a `Secure` cookie on `http://localhost`.

**`links.ts`.** A sign-up link carries `{ email, company, expires }` and an HMAC-SHA256 of it under `APP_SECRET`. `readLink` checks the signature with `timingSafeEqual` and the expiry (one hour). Refuse to start when `APP_SECRET` is shorter than 32 characters.

**`changelog.ts`.** The notes live in `src/content/changelog.ts`, newest first. Start with one note, version `0.1.0`, announcing the app.

**`analytics.ts`.** Start the table with `session_active` (`user`, `daily`), `signed_up` (`tenant`, `first`) and `member_invited` (`user`, `daily`).

**`experiments.ts`.** `defineExperiments({})` with a comment showing where the first one goes. The base runs no test.

## Browser Firebase

`src/lib/firebase-client.ts`, a client module. It initialises the Firebase web app from the `NEXT_PUBLIC_FIREBASE_*` variables, gets Auth, and calls `connectAuthEmulator` when `NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR` is set. Set persistence to `inMemoryPersistence`: the session lives in the server's cookie, and the browser SDK is only the way to get an ID token.

Export one helper, `signInAndStartSession(email, password)`: it calls `signInWithEmailAndPassword`, takes `getIdToken()`, posts it to `POST /api/session`, and throws with the route's `reason` when that fails. Every flow that ends signed in goes through it. `sessions.exchange` refuses a sign-in older than 5 minutes, so the token must come from a sign-in made just now.

## Routes and pages

Public pages sit in `src/app/(public)/`, signed-in pages in `src/app/(app)/`. Every route handler under `/api` that is not marked public starts with `cordwood.access.require(request, permission)`.

### Session

| Route | Does |
|---|---|
| `POST /api/session` (public) | `sessions.exchange(idToken)`, sets the cookie, answers 401 with the reason otherwise |
| `DELETE /api/session` | `sessions.end(cookie)`, clears the cookie |

### Sign-up, with the address proved first

`members.admit` with a password marks the account verified, so it must only run for an address its owner proved. The base proves it with a link.

1. `/sign-up`: a form with e-mail and company name. `POST /api/sign-up` (public) builds `signLink({ email, company })`, makes the address `${APP_ORIGIN}/sign-up/finish#token=...`, and passes it to `sendOrShow`. It answers the same 200 whether or not the address already has an account.
2. `/sign-up/finish`: reads the token after `#`, asks for a name and a password. `POST /api/sign-up/finish` (public) calls `readLink`, creates `tenants/{tenantId}` with the company name and `createdAt` (the id is 20 characters of a random UUID with the hyphens removed), and calls `members.admit(tenantId, { email, role: "owner", name }, { password }, "sign-up")`.
3. When `admit` refuses, delete the tenant document just created and answer the reason. Show `member` and `other_tenant` as "this address already has an account, sign in".
4. On success the page calls `signInAndStartSession` and goes to `/`. The route also records `signed_up`.

### Sign-in and password

- `/sign-in`: e-mail and password, `signInAndStartSession`, then `/`. One message for every failure ("e-mail or password not right"), so the form does not say which addresses exist.
- `/forgot-password`: `POST /api/password-reset` (public) calls `auth().generatePasswordResetLink(email)`, turns it into an app link (below) and passes it to `sendOrShow`. Always 200. Swallow "user not found".
- `/set-password`: reads `oobCode` from the query. With the browser SDK: `verifyPasswordResetCode` gives the e-mail, `confirmPasswordReset` sets the password, then `signInAndStartSession`. Completing the reset is what marks an invited address as verified. Verify that in the walk: if `exchange` answers `email_unverified` after an invite, read the `@cordwood/auth` README's Admit section again before changing anything.

**App links from Firebase links.** `generatePasswordResetLink` and an invite's `link` point at Firebase's own handler page. Read the `oobCode` query parameter from that URL and build `${APP_ORIGIN}/set-password?oobCode=...`. Put this in one function in `src/server/links.ts` and use it for both invites and resets.

### The shell

`src/app/(app)/layout.tsx` is a server component. It calls `requireSession()`, records `session_active` without awaiting anything the page depends on, and reads the changelog status and subscription for the header.

The header holds the app's name, the navigation (dashboard, members, billing), `ChangelogDialog`, a "show this screen's tour" item wired to `replayTour` and `useCanReplay`, and sign out. Sign out calls `DELETE /api/session`, then goes to `/sign-in`.

`src/app/(app)/page.tsx` is the dashboard: a heading with the tenant's name and one empty state that says the product's own screens go here. Mark two elements with `data-tour` (the navigation and the changelog button) and give the dashboard a two-step tour. This is the page the business rules replace first.

Add `src/proxy.ts` only if a later feature needs it. The layout's `requireSession()` already guards the pages.

### Members

`/members` lists `members.list(tenantId)` in `MembersTable`. `canManage` is whether the session's role holds `members.manage`. Above the table, for managers, an invite form with e-mail, name and role.

| Route | Does |
|---|---|
| `POST /api/members` | `members.admit(..., { continueUrl, deliver }, access.uid)`. `deliver` builds the app link from `invite.link` and calls `sendOrShow`. Records `member_invited` |
| `PATCH /api/members/[uid]` | `members.changeRole` |
| `DELETE /api/members/[uid]` | `members.remove`, then `changelog.forget` and `tours.forget` for that person |

Check `[uid]` with `isDocumentId` before using it. Map each refusal reason to a sentence in the app's language.

### Billing

`/billing` shows `SubscriptionCard` with `billing.subscription(tenantId)`. When `billing` is null, show one line instead: billing turns on when `STRIPE_SECRET_KEY` is set. Only a role with `billing.manage` sees the buttons.

Routes: `POST /api/billing/checkout`, `POST /api/billing/portal`, `POST /api/billing/webhook` (public), as in the `cordwood` skill's wiring reference. Each answers 503 when `billing` is null. The price is the lookup key in `STRIPE_PRICE`.

### Release notes

Routes: `POST /api/changelog/read`, `POST /api/changelog/subscribe`, `POST /api/changelog/unsubscribe-page` (public, always 204), `POST /api/changelog/unsubscribe` (public, always 204, the code in `?t=`).

`/changelog/unsubscribe` is a public page that renders `UnsubscribeCard` with `endpoint="/api/changelog/unsubscribe-page"`.

`POST /api/cron/changelog` runs `changelog.send(deliver)`. It is public to the network and private by a header: refuse any request whose `authorization` is not `Bearer ${CRON_SECRET}`, and refuse all of them when `CRON_SECRET` is unset. `deliver` writes the message with `email.send`, `subscription: true` and the two `List-Unsubscribe` headers.

### Surveys

Routes: `POST /api/surveys/ask` and `POST /api/surveys/answer`.

A client component in the shell, `SurveyHost`, calls the ask route once after the dashboard has been open for a few seconds and renders `SurveyPrompt` in the bottom corner when a kind comes back. `usingSince` is the member's `invitedAt`, read on the server. Leave `triggers` empty: the business rules name the acts worth a CSAT or a CES.

### Tours

Routes: `GET /api/tours` and `POST /api/tours`. The shell's layout reads `tours.seen` on the server and passes the list down, so the dashboard's tour knows at first paint whether it was seen.

## Conventions for everything you write

- **Route handlers answer JSON** with an `error` field holding a reason word, never a sentence. Pages turn reasons into sentences.
- **Forms** are client components that post to a route and show the route's reason. Disable the submit button while a request is out, and say why a field is wrong next to that field.
- **Dates** cross a JSON route as strings. Turn them back into `Date` before a component that formats them.
- **No `console.log` of an address, a token or a link**, except the dev link that `sendOrShow` hands to the page.
- **One language.** Every label, message and e-mail in the language chosen in step 1.

## What must not be in the base

No landing page, no pricing page, no settings beyond members and billing, no dark-mode switch, no extra dependency for state or forms. The user's idea decides those, and each one built now is one they may have to remove.
