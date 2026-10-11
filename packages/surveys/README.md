# @cordwood/surveys

In-app NPS, CSAT and CES. The package decides when a person is due a survey, stores each answer without a name, and computes the three scores. You draw the question.

```bash
pnpm add @cordwood/surveys @cordwood/firebase firebase-admin
```

Node 22 or later. Server only.

## Set up

```ts
import { createSurveys } from "@cordwood/surveys";
import { firestore } from "@cordwood/firebase";

export const surveys = createSurveys({
  firestore: firestore(),
  triggers: { exported: "csat", imported: "ces" },
});
```

`triggers` names the acts in your app that call for a survey. Use `csat` after something a person may be pleased with, and `ces` after something that took effort. NPS needs no trigger: it comes with time.

## Ask

Call `ask` when you are about to show a question.

```ts
const kind = await surveys.ask({
  tenantId: access.tenantId,
  userId: access.uid,
  usingSince: member.invitedAt,
  act: "exported",
});
// "nps" | "csat" | "ces" | null
```

The survey is recorded as shown in that same call, so a second call a moment later answers null. A dismissed question counts as asked.

| Rule | Default |
|---|---|
| Two surveys to the same person are at least this far apart. | 7 days |
| NPS waits until the person has used the product this long. | 14 days |
| NPS comes back to the same person after this long. | 90 days |

An act's survey comes before NPS. Change any default with `rules: { minIntervalDays, npsAfterDaysOfUse, npsEveryDays }`.

## Answer

```ts
const stored = await surveys.answer({
  tenantId: access.tenantId,
  userId: access.uid,
  kind: body.kind,
  score: body.score,
  comment: body.comment,
});
// "stored" | "not_asked" | "invalid"
```

Pass the request's fields as they arrived. The package checks them.

| Survey | Score | Question it suits |
|---|---|---|
| `nps` | 0 to 10 | How likely are you to recommend us? |
| `csat` | 1 to 5 | How satisfied are you with what you just did? |
| `ces` | 1 to 7 | How easy was that? |

A comment is optional and holds 500 characters at most.

An answer is stored only when that person was asked that survey in the last day and has not answered it. One person cannot answer twice to move a score.

The stored answer holds the survey, the score, the comment and the instant. It holds no user id.

## Read the scores

```ts
const results = await surveys.results({ days: 90 });
const mine = await surveys.results({ days: 90, tenantId });
```

| Field | Meaning |
|---|---|
| `nps.value` | Promoters (9, 10) minus detractors (0 to 6), as a share of all answers. Null below 20 answers. |
| `csat.value` | The percentage who answered 4 or 5. |
| `ces.value` | The mean answer, to one decimal. |
| `comments` | The 10 latest comments with their score and day. Change the count with `comments`. |

Each score also carries `answers`, the number it was computed from. `nps`, `csat`, `ces` and `dueSurvey` are exported as pure functions.

## The index

Reading across tenants queries every tenant's `survey_answers` at once, which needs an index the package ships. Add it to your project with the command from `@cordwood/firebase`:

```bash
pnpm exec cordwood-firebase indexes
firebase deploy --only firestore:indexes
```

Reading one tenant's scores needs none.

## Where it stores

| Path | Holds |
|---|---|
| `tenants/{tenantId}/survey_state/{userId}` | When each survey was last shown to the person, and last answered. |
| `tenants/{tenantId}/survey_answers/{id}` | One answer. |
