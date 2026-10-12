# @cordwood/experiments

A/B tests for a public page or a screen inside the app. The package gives each visitor a stable arm, counts each exposure and conversion once, and compares every arm with the control. You build the arms.

```bash
pnpm add @cordwood/experiments firebase-admin
```

Node 22 or later. Server only.

## Set up

```ts
import { createExperiments, defineExperiments, sampleSize } from "@cordwood/experiments";
import { firestore } from "@cordwood/firebase";

export const experiments = createExperiments({
  firestore: firestore(),
  experiments: defineExperiments({
    "pricing-2": {
      arms: { control: 1, annual_first: 1 },
      goals: ["signup", "paid"],
      perArm: sampleSize(0.1, 0.02), // 3841
    },
  }),
});
```

`arms` maps each arm to its weight, and the first one is the control. `{ control: 3, annual_first: 1 }` sends a quarter of the visitors to the new arm.

`perArm` is how many visitors each arm needs before you read the result. `sampleSize(0.1, 0.02)` answers 3841: the number that tells a 12% rate from a 10% one, at 5% significance and 80% power. Decide it before the first visitor.

A new round gets a new id. The id is what the split is cut with, so reusing one carries the old split and the old counts into the new round.

## Pick the arm

```ts
const arm = experiments.arm("pricing-2", unit);
// "control" | "annual_first"
```

The arm is a hash of the experiment's id and the unit, stored nowhere. Every server derives the same answer, so no second record can disagree with it.

A unit is whatever you split. Inside the app, use the user's id or the tenant's. On a public page nobody is signed in, so mint an id and keep it in a cookie:

```ts
import { createVisitors } from "@cordwood/experiments";

const visitors = createVisitors({ secret: process.env.VISITOR_SECRET });

const unit = visitors.read(request.cookies.get("visitor")?.value);
if (!unit) {
  const { id, cookie } = visitors.mint();
  response.cookies.set("visitor", cookie, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 120 * 86_400 });
}
```

The cookie holds the id and its HMAC. `read` answers null for an id your secret did not sign, so a script cannot invent visitors to fill an arm. The secret needs 32 characters or more.

## Count

```ts
import { isPrefetch, isRobot, refusesTracking } from "@cordwood/experiments";

const counted = !isRobot(request.headers) && !isPrefetch(request.headers) && !refusesTracking(request.headers);
if (counted) await experiments.expose("pricing-2", unit);
```

Call `expose` where the arm is shown. Then call `convert` from the server route that performs the act:

```ts
await experiments.convert("pricing-2", unit, "signup");
```

| Answer | Meaning |
|---|---|
| `counted` | Stored. |
| `repeated` | This unit was already counted for it. Nothing was written. |
| `not_exposed` | A conversion of a unit that never saw the experiment. Not stored. |
| `invalid` | An unknown experiment or goal, or a unit that is not a string of 1 to 200 characters. |
| `failed` | Firestore refused. The error's code went to `log`. |

Neither call throws. A lost count must not cost a visitor the page, or a stranger their sign-up.

Each event is one document, created and never updated. A flood of reports for one visitor writes one document per goal at most.

`isRobot` reads the user agent. Firebase App Hosting's CDN replaces it with `Google`, and there the function reads `Sec-Fetch-Mode`, which browsers send and scripts do not. `refusesTracking` is true for a browser sending Global Privacy Control.

## Read the result

```ts
const results = await experiments.results("pricing-2");
```

```ts
{
  control: "control",
  arms: {
    control:      { exposed: 3902, goals: { signup: { converted: 391, rate: 0.1002 }, paid: { ... } } },
    annual_first: { exposed: 3875, goals: { signup: { converted: 467, rate: 0.1205 }, paid: { ... } } },
  },
  split: { pValue: 0.76, mismatch: false },
  reached: true,
  comparisons: {
    annual_first: { signup: { difference: 0.0203, interval: [0.0064, 0.0342], pValue: 0.0043 }, paid: { ... } },
  },
}
```

Read it in this order.

1. `split.mismatch`. True means the arms did not receive what their weights say (a chi-square p-value below 0.001). Something other than the hash decided who was counted, such as a redirect that loses one arm's visitors. Find it before you believe any rate.
2. `reached`. False means an arm is still short of `perArm`. A p-value read every morning crosses 0.05 by chance far more often than 5% of the time, so wait.
3. `comparisons`. `difference` is the arm's rate minus the control's, and `interval` is its 95% range. The p-value comes from a two-proportion z-test.

`compare`, `splitCheck`, `sampleSize` and `armOf` are exported as pure functions.

## The index

Events carry an `expiresAt`, 180 days after they are written. Change it with `retentionDays`. The package ships the TTL policy that deletes them then. Add it to your project with the command from `@cordwood/firebase`:

```bash
pnpm exec cordwood-firebase indexes
firebase deploy --only firestore:indexes
```

## Where it stores

| Path | Holds |
|---|---|
| `experiment_events/{hash}` | One exposure or one conversion: the experiment, the arm, the kind, the day, and when it expires. |

The document's id is a hash of the experiment, the unit and the kind. The unit itself is stored nowhere, and neither is an IP or a user agent.
