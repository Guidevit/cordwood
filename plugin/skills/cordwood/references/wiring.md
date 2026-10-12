# Wiring each package

One section per package: the module that builds the instance, the routes the app adds, and what trips people up. The option names and return values are in `node_modules/@cordwood/<name>/README.md`. Read it for the installed version before writing the call.

Paths below use `src/server/` and `src/app/api/`. Follow the project's own layout where it differs.

## @cordwood/firebase

No module of its own. Import `firestore()`, `auth()` and `tenantRef(db, tenantId)` where needed.

- Credentials are Application Default Credentials. With `FIRESTORE_EMULATOR_HOST` or `FIREBASE_AUTH_EMULATOR_HOST` set, the same calls reach the emulators.
- Deploy Firestore rules that deny every client read and write. The README has the 8 lines.
- `isDocumentId(value)` checks any id that arrives in a URL before it reaches `doc()`.
- `pnpm exec cordwood-firebase indexes` merges every installed package's indexes into `firestore.indexes.json`. Add `--check` to CI.

## @cordwood/auth

`src/server/auth.ts` exports `roles` (from `defineRoles`) and `cordwood` (from `createAuth`). Name the permissions after what the app does (`"invoices.write"`), and pick one as `managePermission`.

| Route | Calls |
|---|---|
| `POST /api/session` | `sessions.exchange(idToken)`, then sets the cookie with `cookieName` and `cookieOptions` |
| `DELETE /api/session` | `sessions.end(cookie)`, then clears the cookie |
| `GET /api/members` | `access.require`, then `members.list(tenantId)` |
| `POST /api/members` | `members.admit(tenantId, { email, role, name }, { continueUrl, deliver }, access.uid)` |
| `PATCH /api/members/[uid]` | `members.changeRole(tenantId, uid, role, access.uid)` |
| `DELETE /api/members/[uid]` | `members.remove(tenantId, uid, access.uid)` |

- A tenant's first member is admitted with `{ password }` in place of `continueUrl` and `deliver`, from the sign-up flow.
- `deliver` sends the invite. Use `@cordwood/email` there. When it throws, the admission is undone.
- `access.require` already refuses a cross-site write. Do not add a second CSRF check.
- Server components read the session with `sessions.read(cookie)`: the cookie's value, or undefined. It answers the session, or null when there is none or it no longer holds.

## @cordwood/email

`src/server/email.ts` exports `email` from `createEmailSender({ apiKey, from, subscriptionFrom, log })`.

- Variables: `SENDGRID_API_KEY`, and `SENDGRID_WEBHOOK_PUBLIC_KEY` when the event webhook is used.
- `send` throws when nothing was sent. In a route, answer with `failureStatus(error)`.
- A newsletter or release note sets `subscription: true` and needs `subscriptionFrom`. Everything else is transactional and bypasses the unsubscribe list.
- `POST /api/email/events` reads the webhook with `createEventReader(...).read(rawBody, request.headers)` and hands `reading.events` to whoever acts on them, such as `changelog.applyMailEvents`.

## @cordwood/billing

`src/server/billing.ts` exports `billing` from `createBilling({ stripe, firestore, origin, webhookSecret, log })`. Build the Stripe client with `STRIPE_CLIENT_OPTIONS`.

| Route | Calls |
|---|---|
| `POST /api/billing/checkout` | `billing.checkout({ tenantId, price, email, successPath, cancelPath })`, answers the URL |
| `POST /api/billing/portal` | `billing.portal({ tenantId, returnPath })`, answers the URL or 409 when it is null |
| `POST /api/billing/webhook` | `billing.handleWebhook(rawBody, signature)`, public, answers `response.status` |

- Variables: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and the app's origin.
- `price` is a Stripe lookup key. The user creates products and prices on Stripe.
- `checkout` throws `LiveSubscription` when the tenant already has one: answer 409 and offer the portal.
- To decide what a tenant may do, read `billing.subscription(tenantId)` and test `PAYING_STATUSES.has(status)`. Never call Stripe for that.
- On Stripe, the webhook endpoint sends `customer.subscription.*`, `checkout.session.completed` and `invoice.*`.

## @cordwood/analytics

`src/server/analytics.ts` exports `analytics` from `createAnalytics({ firestore, events, timeZone, log })`, with the event table from `defineEvents`.

- The table is closed. Add an event to the table before recording it.
- Properties hold ids, words from a list, or numbers. An e-mail or free text does not fit, on purpose.
- Record `session_active` (or the app's equivalent) once per authenticated request or page view. `keep: "daily"` makes that one row per person per day.
- `analytics.engagement(type)` answers DAU, WAU, MAU, stickiness and the daily series for an operator's dashboard.
- It needs its index: run the indexes command.

## @cordwood/surveys

`src/server/surveys.ts` exports `surveys` from `createSurveys({ firestore, triggers, rules })`.

| Route | Calls |
|---|---|
| `POST /api/surveys/ask` | `surveys.ask({ tenantId, userId, usingSince, act })`, answers the kind or null |
| `POST /api/surveys/answer` | `surveys.answer({ tenantId, userId, kind, score, comment })` with the body's fields as they arrived |

- `ask` records the survey as shown. Call it once, at the moment the app would show a question.
- `triggers` maps the app's own acts to `csat` or `ces`. NPS comes with time and needs none.
- `surveys.results({ days })` is for an operator's page. Across tenants it needs the package's index.

## @cordwood/changelog

`src/server/changelog.ts` exports the notes list and `changelog` from `createChangelog({ firestore, auth, notes, origin })`.

| Route | Calls |
|---|---|
| `GET /api/changelog` | `status(tenantId, userId)` and `subscription(tenantId, userId)` |
| `POST /api/changelog/read` | `markRead(tenantId, userId)` |
| `POST /api/changelog/subscribe` | `subscribe(tenantId, userId, on, "settings")` |
| `POST /api/changelog/unsubscribe-page` | `unsubscribe(token)`, public, always 204 |
| `POST /api/changelog/unsubscribe` | `unsubscribe(searchParams.get("t"))`, public, always 204 |
| a scheduled route | `send(deliver)`, which throws `SendStopped` |

- `notes` is the app's own list, newest first, each with a `version`.
- `deliver` builds and sends one message with `@cordwood/email`, `subscription: true`, and the two `List-Unsubscribe` headers from `oneClickUrl`.
- The page at `unsubscribePath` renders the `unsubscribe-card` component.
- Call `forget(tenantId, userId)` where a member is removed.
- It needs its index: run the indexes command.

## @cordwood/experiments

`src/server/experiments.ts` exports `experiments` from `createExperiments({ firestore, experiments: defineExperiments({...}) })`, and `visitors` from `createVisitors({ secret })` when the test runs on a public page.

- Decide `perArm` before the first visitor with `sampleSize(baseline, detectable)`.
- A unit is a signed visitor id on a public page, or a user or tenant id inside the app.
- Public page: `proxy.ts` (Next 16, `middleware.ts` before) reads or mints the visitor cookie, picks `experiments.arm(id, unit)` and rewrites to the arm's route.
- Call `expose` where the arm is rendered, and skip it for `isRobot`, `isPrefetch` and `refusesTracking`.
- Call `convert` from the server route that performs the act (the sign-up, the payment). Never from the browser's report.
- Variable: `VISITOR_SECRET`, 32 characters or more.
- Run the indexes command so the TTL policy that deletes old events is deployed.

## @cordwood/tour

`src/server/tours.ts` exports `tours` from `createTours({ firestore, tours: [...] })`, with one id per screen that has a tour.

| Route | Calls |
|---|---|
| `GET /api/tours` | `tours.seen(tenantId, userId)` |
| `POST /api/tours` | `tours.end({ tenantId, userId, tour, how, step })` with the body's fields as they arrived |

- In the screen, mark each target with `data-tour="..."`, call `useTour({ steps, ready, seen, onEnd })` from `@cordwood/tour/react`, and render the `tour-card` component.
- Pass `seen: undefined` while the list loads and after a failed read. Only `false` opens the tour.
- In `onEnd`, post the ending unless `replay` is true.
- `replayTour()` and `useCanReplay()` wire a "Show this screen's tour" menu item.
