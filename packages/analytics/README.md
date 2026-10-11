# @cordwood/analytics

A product-event log in Firestore, and daily, weekly and monthly active users computed from it. An event holds ids and nothing else, a repeat lands on the same row, and recording one never fails the request that caused it.

```bash
pnpm add @cordwood/analytics firebase-admin
```

Node 22 or later. Server only.

## Define your events

The table is closed. A field you did not declare here refuses the event.

```ts
import { createAnalytics, defineEvents } from "@cordwood/analytics";
import { firestore } from "@cordwood/firebase";

const events = defineEvents({
  session_active: { subject: "user", keep: "daily" },
  feature_used: {
    subject: "user",
    keep: "daily",
    props: { feature: ["search", "export"] },
    key: ["feature"],
  },
  first_import: { subject: "tenant", keep: "first" },
  plan_changed: {
    subject: "tenant",
    keep: "first",
    props: { source: "id", monthly: "number" },
    key: ["source"],
  },
});

export const analytics = createAnalytics({
  firestore: firestore(),
  events,
  timeZone: "America/Sao_Paulo",
  log: console.error,
});
```

| Option | Values | Meaning |
|---|---|---|
| `subject` | `user` | The event names a person by their uid. |
| | `tenant` | The event is the tenant's own and names no person. |
| `keep` | `daily` | One row per subject per day. A repeat adds to the row's `count`. |
| | `first` | The row is created once and keeps its instant. A repeat is refused. |
| `props` | a list of words, `"id"`, `"number"` | What else the event carries. Every property is required. |
| `key` | property names | The properties that make the event a different one: the feature used, the payment provider's event id. |

An `"id"` takes letters, digits and `_.:-`, at most 128 of them. An e-mail or a sentence does not fit, on purpose: whoever reads these events operates the product and belongs to no tenant.

`timeZone` is the zone a day is counted in. Use the one your users work in.

## Record

```ts
await analytics.record("session_active", { tenantId, userId });
await analytics.record("feature_used", { tenantId, userId, props: { feature: "export" } });
```

`record` cannot throw. It answers `recorded`, `already_recorded` (a `first` event whose row exists), `invalid` or `failed`, and logs the last two by field name or error code.

One row per person per day is what makes daily active users a count of people. The row's `count` is their visits, so visits per active user is the sum of `count` over the rows.

Pass `{ counts: false }` when the person is active but this is not a new visit, such as a request under a session that began days ago. The row exists and its `count` stays.

Pass `{ at }` in a backfill, with the real instant of something that happened before the log existed.

### Inside a transaction

A `first` event that must commit with the write that caused it goes in that write's transaction.

```ts
await db.runTransaction(async (tx) => {
  const counted = await analytics.recordInTransaction(tx, "plan_changed", {
    tenantId,
    props: { source: stripeEvent.id, monthly: 49 },
  });
  tx.set(subscriptionRef, next);
});
```

Here a failure fails the transaction, and an event the table refuses throws. It answers false when the row already exists, so a webhook delivered twice counts once. Call it before the transaction's own writes, since it reads its row.

## Read

```ts
const result = await analytics.engagement("session_active");
```

| Field | Meaning |
|---|---|
| `dau`, `wau`, `mau` | People active today, in the last 7 days, in the last 30. |
| `stickiness` | `dau / mau`. Null with nobody in the month. |
| `series` | One point per day over the period, 30 days by default. |
| `frequency` | How many of the month's people came on 1, 2 to 4, 5 to 14, or 15 or more days. |

`analytics.activeDays(type, { from, to })` returns who was active on each day, and `engagement(days, today)` is exported as a pure function for data you already hold.

## The index

Reading needs one composite index on `product_events`: `type` then `day`. The package ships it. Add it to your project with the command from `@cordwood/firebase`:

```bash
pnpm exec cordwood-firebase indexes
firebase deploy --only firestore:indexes
```

With a `collection` option other than the default, write the same index for your collection name.

## Not in this version

Retention cohorts, activation funnels and revenue. The rows they need are already in the log.
