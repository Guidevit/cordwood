# Cordwood components

Six React components for the screens the packages leave to you. They install the shadcn/ui way: the CLI copies the source into your app, where it uses your own `Button`, `Dialog` and colours. Nothing here ships CSS.

Your app needs shadcn/ui set up (`npx shadcn init`), which means React and Tailwind.

## Install

Name the registry once, in your app's `components.json`:

```json
{
  "registries": {
    "@cordwood": "https://raw.githubusercontent.com/Guidevit/cordwood/main/registry/r/{name}.json"
  }
}
```

Then add what you need:

```bash
npx shadcn add @cordwood/tour-card @cordwood/survey-prompt
```

The CLI also adds the shadcn primitives a component uses, and `@cordwood/tour` for the tour card. The files land in `components/`, and from then on they are yours to edit.

| Component | For | Uses |
|---|---|---|
| `tour-card` | [`@cordwood/tour`](../packages/tour) | `button`, `popover` |
| `survey-prompt` | [`@cordwood/surveys`](../packages/surveys) | `button`, `label`, `textarea` |
| `changelog-dialog` | [`@cordwood/changelog`](../packages/changelog) | `button`, `dialog`, `label`, `switch` |
| `unsubscribe-card` | [`@cordwood/changelog`](../packages/changelog) | `button`, `card` |
| `subscription-card` | [`@cordwood/billing`](../packages/billing) | `badge`, `button`, `card` |
| `members-table` | [`@cordwood/auth`](../packages/auth) | `alert-dialog`, `button`, `select`, `table` |

## Every text is yours

No component holds a sentence. Each takes a `labels` prop with every word it shows, so one set of files serves an app in Portuguese and another in English.

A component also calls no route. It hands you what happened (`onAnswer`, `onRead`, `onRemove`) and you call your server, which calls the package.

## tour-card

```tsx
"use client";
import { useTour } from "@cordwood/tour/react";
import { TourCard } from "@/components/tour-card";

const tour = useTour({ steps: STEPS, ready: !loading, seen, onEnd });

<TourCard
  tour={tour}
  labels={{
    skip: "Skip",
    back: "Back",
    next: "Next",
    done: "Done",
    position: (current, total) => `${current} of ${total}`,
  }}
/>
```

Each step is `{ target, title, text }`. The card anchors under the element marked `data-tour={target}`, draws a ring around it and dims the rest. Escape skips the tour, and the focus returns to the last element it pointed at.

## survey-prompt

```tsx
import { SurveyPrompt } from "@/components/survey-prompt";

{kind ? (
  <SurveyPrompt
    kind={kind}
    labels={{
      question: "How likely are you to recommend us?",
      low: "Not likely",
      high: "Very likely",
      comment: "What is the main reason?",
      submit: "Send",
      dismiss: "Not now",
    }}
    onAnswer={async (answer) => {
      await post("/api/surveys/answer", answer);
      setKind(null);
    }}
    onDismiss={() => setKind(null)}
  />
) : null}
```

`kind` is what `surveys.ask` answered. The scale follows it: 0 to 10 for `nps`, 1 to 5 for `csat`, 1 to 7 for `ces`. The comment field and the send button appear once a score is chosen. Place the prompt yourself, in a corner or inside a page.

## changelog-dialog

```tsx
import { ChangelogDialog } from "@/components/changelog-dialog";

<ChangelogDialog
  notes={NOTES}
  unread={status.unread}
  onRead={() => post("/api/changelog/read")}
  labels={{
    open: "What's new",
    unread: "New release",
    title: "Release notes",
    empty: "No release yet.",
  }}
  email={{
    on: subscription.on,
    label: "Send me these by e-mail",
    hint: "One message per release.",
    onChange: (on) => post("/api/changelog/subscribe", { on }),
  }}
/>
```

It renders the button and the dialog. The button shows a dot while `unread` is true, and opening the dialog calls `onRead`. A note is `{ version, title, date?, body? }`, and `body` takes any React node. Leave `email` out to hide the switch.

## unsubscribe-card

```tsx
import { UnsubscribeCard } from "@/components/unsubscribe-card";

export default function Page() {
  return (
    <UnsubscribeCard
      endpoint="/api/changelog/unsubscribe-page"
      labels={{
        title: "Stop these e-mails",
        text: "You will stop receiving our release notes by e-mail.",
        confirm: "Unsubscribe",
        done: "Done. No more release notes by e-mail.",
        failed: "That did not go through. Try again.",
        missing: "This link is incomplete.",
      }}
    />
  );
}
```

Put it on the page your `unsubscribePath` points at. It reads the code after `#` and posts `{ token }` to `endpoint` when the person clicks. The route calls `changelog.unsubscribe(token)` and answers 204 every time.

## subscription-card

```tsx
import { SubscriptionCard } from "@/components/subscription-card";

<SubscriptionCard
  subscription={subscription}
  labels={{
    title: "Plan",
    none: "No plan yet.",
    statuses: { active: "Active", trialing: "Trial", past_due: "Payment late" },
    renewsOn: (date) => `Renews on ${date}`,
    endsOn: (date) => `Ends on ${date}`,
    trialEndsOn: (date) => `Trial ends on ${date}`,
    subscribe: "Subscribe",
    manage: "Manage plan",
    payInvoice: "Pay invoice",
  }}
  onSubscribe={async () => {
    location.href = (await post("/api/billing/checkout")).url;
  }}
  onManage={async () => {
    location.href = (await post("/api/billing/portal")).url;
  }}
/>
```

`subscription` is what `billing.subscription(tenantId)` answers, or null. A live subscription shows its status, its next date and the way to the portal. Anything else offers Checkout. An open invoice adds a link to pay it. Format dates your way with `formatDate`.

## members-table

```tsx
import { MembersTable } from "@/components/members-table";

<MembersTable
  members={members}
  canManage={canManage}
  currentUid={me.uid}
  labels={{
    member: "Member",
    role: "Role",
    actions: "Actions",
    roles: { admin: "Admin", member: "Member" },
    roleOf: (member) => `Role of ${member.email}`,
    remove: "Remove",
    removeTitle: (member) => `Remove ${member.email}?`,
    removeText: "They lose access at once.",
    cancel: "Cancel",
    empty: "Nobody else yet.",
  }}
  onChangeRole={(uid, role) => post("/api/members/role", { uid, role })}
  onRemove={(uid) => post("/api/members/remove", { uid })}
/>
```

`canManage` comes from the permission your server checked. With it, every row but the person's own gets a role picker and a remove button, and removing asks first.

## Work on it

The folder is a small shadcn project of its own, so each component is type-checked against the real primitives in `components/ui`.

```bash
pnpm --filter @cordwood/registry build      # writes r/*.json, which is committed
pnpm --filter @cordwood/registry typecheck
pnpm vitest run registry                    # 37 tests in jsdom
```

Commit `r/` with the source. CI fails when the two disagree.
