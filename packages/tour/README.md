# @cordwood/tour

Guided tours for a screen's first visit. The server half records which tours each person has seen. The browser half decides when a tour opens and walks its steps. It ships no markup and no styles: the card is your own component library's popover.

```bash
pnpm add @cordwood/tour @cordwood/firebase firebase-admin
```

Node 22 or later on the server. React 18 or later in the browser.

## On the server

```ts
import { createTours } from "@cordwood/tour";
import { firestore } from "@cordwood/firebase";

export const tours = createTours({
  firestore: firestore(),
  tours: ["queue", "settings", "billing"],
});
```

Two routes are enough. One answers what the person has seen:

```ts
const seen = await tours.seen(access.tenantId, access.uid);
// ["queue"]
```

The other records how a tour ended. Pass the request's fields as they arrived:

```ts
const { status, seen } = await tours.end({
  tenantId: access.tenantId,
  userId: access.uid,
  tour: body.tour,
  how: body.how,
  step: body.step,
});
```

| `status` | Meaning |
|---|---|
| `recorded` | The first time this person ended this tour. |
| `already` | They had ended it before. The first ending was kept. |
| `invalid` | A tour outside the list, a `how` other than `completed` or `skipped`, or a skip with no step from 1 to 20. |

`recorded` is the moment to count the ending in your product analytics. Change the step limit with `maxStep`. Call `tours.forget(tenantId, userId)` where you remove a member.

## On the screen

Mark each element a step points at:

```tsx
<section data-tour="list">...</section>
<div data-tour="filters">...</div>
```

Then call the hook with the steps. A step needs a `target`, and the rest is whatever your card shows.

```tsx
"use client";
import { useTour } from "@cordwood/tour/react";

const STEPS = [
  { target: "list", title: "Your queue", text: "Every open item, most urgent first." },
  { target: "filters", title: "Filters", text: "Narrow the list by owner or status." },
];

const tour = useTour({
  steps: STEPS,
  ready: !loading,
  seen: seen?.includes("queue"),
  onEnd: ({ how, step, replay }) => {
    if (!replay) saveEnding({ tour: "queue", how, step });
  },
});
```

| Field | Holds |
|---|---|
| `open` | Whether to show the card. |
| `step`, `target` | The current step and its element. |
| `index`, `count`, `isLast` | The position, for "2 of 4" and for the last button's label. |
| `next()`, `back()` | Move. `next` on the last step completes the tour. |
| `skip()`, `complete()` | End it. `skip` reports the step the person was on. |
| `available` | The tour could open here. |

The tour opens when four things hold: `ready` is true, `seen` is false, a target is on the page, and no other dialog is open.

- `seen` left undefined keeps the tour closed. Pass undefined while the answer loads and after a failed read, so a network error does not reopen every tour.
- A step whose element is missing is left out. People without permission for a button never see its step.
- A dialog opening over the tour makes it step aside with nothing recorded. It returns at the same step when the dialog closes.
- The steps are fixed when the tour first shows. A new array on each render does not send it back to step 1.

## Draw the card

Use the popover or dialog primitive your project already has. It brings the focus trap and Escape, which you should not rebuild. This is the wiring with Radix:

```tsx
import { CARD_ATTRIBUTE, focusTarget, useTargetBox, useTourAnchor } from "@cordwood/tour/react";

const card = useRef<HTMLDivElement>(null);
const anchor = useTourAnchor(tour.target, card);
const box = useTargetBox(tour.open ? tour.target : null);
const last = useRef<HTMLElement | null>(null);
useEffect(() => {
  if (tour.target) last.current = tour.target;
}, [tour.target]);

<Popover open={tour.open} modal onOpenChange={(open) => !open && tour.skip()}>
  {anchor ? <PopoverAnchor virtualRef={anchor} /> : null}
  {box ? <Ring box={box} /> : null}
  <PopoverContent
    ref={card}
    {...{ [CARD_ATTRIBUTE]: "" }}
    sideOffset={4}
    collisionPadding={16}
    onCloseAutoFocus={(event) => {
      event.preventDefault();
      focusTarget(last.current);
    }}
  >
    <p>{tour.index + 1} of {tour.count}</p>
    <PopoverTitle>{tour.step?.title}</PopoverTitle>
    <PopoverDescription>{tour.step?.text}</PopoverDescription>
    <Button variant="ghost" onClick={tour.skip}>Skip</Button>
    {tour.index > 0 ? <Button variant="outline" onClick={tour.back}>Back</Button> : null}
    <Button onClick={tour.next}>{tour.isLast ? "Done" : "Next"}</Button>
  </PopoverContent>
</Popover>
```

Four details in it matter.

1. `CARD_ATTRIBUTE` marks the card as the tour's own. Without it the tour sees an open dialog, its own, and closes.
2. `useTourAnchor` keeps the whole card on screen over a target taller than the window, where a positioning library alone leaves the card above the top edge. Give the library the same `sideOffset` and `collisionPadding`, or pass `{ gap, margin }` to the hook. With Floating UI, hand it `anchor.current`.
3. `useTargetBox` follows the target every frame, for the ring. `Ring` is yours: a fixed, `aria-hidden` box at `box`, with `pointer-events: none`.
4. `focusTarget` returns the focus to the last step's element when the card closes, so a keyboard user continues from where the tour pointed.

Escape arrives through `onOpenChange` and counts as a skip. If the card animates in, keep it under 300ms and turn it off under `prefers-reduced-motion`.

## Open it again

```tsx
import { replayTour, useCanReplay } from "@cordwood/tour/react";

const canReplay = useCanReplay();
{canReplay ? <MenuItem onSelect={replayTour}>Show this screen's tour</MenuItem> : null}
```

`useCanReplay` is true while the screen on show has a tour that could open. A replayed tour ends with `replay: true`. Do not record that ending: the person had already seen the tour, and counting it would turn someone who finished in June into a skip in September.

## Outside React

`createTourController(onEnd)` is the same logic with `update`, `subscribe` and `getSnapshot`. The hooks are a thin layer over it.

## Where it stores

| Path | Holds |
|---|---|
| `tenants/{tenantId}/tour_state/{userId}` | Each tour the person ended: how, when, and the step of a skip. |
