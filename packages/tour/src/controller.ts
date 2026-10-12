// When a tour opens, which step it shows, and how it moves and ends. No React and no markup: it reads
// the page and answers a snapshot.

/** One step: it points at the element marked `data-tour={target}`. The rest is yours (a title, a text). */
export type Step = { target: string };

export type TourInputs<S extends Step> = {
  steps: readonly S[];
  /** The screen has loaded and has something to show. */
  ready: boolean;
  /**
   * Whether the person has seen this tour, from the server. Undefined while that is unknown, and after
   * a read that failed: the tour stays closed then, since "unknown" is not "never seen".
   */
  seen: boolean | undefined;
};

/** How a tour ended. `step` is from 1, on a skip. `replay` is a tour opened again by request. */
export type TourEnd = { how: "completed" | "skipped"; step?: number; replay: boolean };

export type TourSnapshot<S extends Step> = {
  open: boolean;
  step: S | null;
  target: HTMLElement | null;
  /** The step's position among the ones being walked, from 0. */
  index: number;
  count: number;
  isLast: boolean;
  /** The tour could open here: the screen is ready and a target is on the page. */
  available: boolean;
};

export type TourController<S extends Step> = {
  update(inputs: TourInputs<S>): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): TourSnapshot<S>;
  next(): void;
  back(): void;
  /** Ends the tour unfinished: what Escape and a "Skip" button do. */
  skip(): void;
  complete(): void;
  /** Opens the tour again, seen or not. */
  replay(): void;
  destroy(): void;
};

/** Put this attribute on the tour's own card: it is a dialog too, and a tour never waits for itself. */
export const CARD_ATTRIBUTE = "data-tour-card";

// An open dialog that is not the tour's card. One animating out is already marked closed, so a sheet
// closing to show the tour does not hold it back.
const OTHER_DIALOG = [
  `dialog[open]:not([${CARD_ATTRIBUTE}])`,
  `[role="dialog"]:not(dialog):not([${CARD_ATTRIBUTE}]):not([data-state="closed"]):not([hidden])`,
  `[role="alertdialog"]:not(dialog):not([data-state="closed"]):not([hidden])`,
].join(", ");

export function otherDialogOpen(): boolean {
  return document.querySelector(OTHER_DIALOG) !== null;
}

export function targetOf(step: Step): HTMLElement | null {
  // Compared as a value, never built into a selector: a target's name needs no escaping.
  for (const element of document.querySelectorAll<HTMLElement>("[data-tour]"))
    if (element.getAttribute("data-tour") === step.target) return element;
  return null;
}

/** Focus goes back to a step's target. A section is not focusable, so it becomes so by script only. */
export function focusTarget(target: HTMLElement | null): void {
  if (!target) return;
  if (target.tabIndex < 0 && !target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
  target.focus();
}

const CLOSED: TourSnapshot<never> = {
  open: false,
  step: null,
  target: null,
  index: 0,
  count: 0,
  isLast: false,
  available: false,
};

/** The snapshot before the page exists: a server render, and a tour not yet mounted. */
export const closedSnapshot = <S extends Step>(): TourSnapshot<S> => CLOSED;

const WATCHED = ["data-tour", "data-state", "role", "open", "hidden"];

// The tours that could open on the screen now, the newest last: what a "Replay this tour" item asks.
const replayable: { replay(): void }[] = [];
const replayListeners = new Set<() => void>();
const replayableChanged = () => {
  for (const listener of replayListeners) listener();
};

/** Whether the screen on show has a tour that could open. */
export function canReplay(): boolean {
  return replayable.length > 0;
}

export function subscribeCanReplay(listener: () => void): () => void {
  replayListeners.add(listener);
  return () => replayListeners.delete(listener);
}

/** Opens the tour of the screen on show again. For an item in the account or help menu. */
export function replayTour(): void {
  replayable.at(-1)?.replay();
}

export function createTourController<S extends Step>(
  onEnd: (end: TourEnd) => void,
): TourController<S> {
  let inputs: TourInputs<S> = { steps: [], ready: false, seen: undefined };
  let snapshot: TourSnapshot<S> = CLOSED;
  let observer: MutationObserver | null = null;
  // Closed by the person in this visit: it stays closed until the server's answer catches up.
  let closed = false;
  let replaying = false;
  // The steps being walked. Chosen when the tour first shows, and only then: a screen that builds its
  // steps on each render hands a new array with the same steps, and new data would otherwise send an
  // open tour back to step 1. A tour that stepped aside for a dialog comes back at its step.
  let walking: S[] | null = null;
  let index = 0;
  const listeners = new Set<() => void>();

  const handle = { replay: () => controller.replay() };
  const setReplayable = (on: boolean) => {
    const at = replayable.indexOf(handle);
    if (on === at >= 0) return;
    if (on) replayable.push(handle);
    else replayable.splice(at, 1);
    replayableChanged();
  };

  function compute(): TourSnapshot<S> {
    const present = inputs.ready ? inputs.steps.filter((step) => targetOf(step)) : [];
    const available = present.length > 0;
    const wanted = available && (replaying || (inputs.seen === false && !closed));
    if (!wanted) {
      walking = null;
      return available ? { ...CLOSED, available } : CLOSED;
    }
    // Nothing opens over another dialog. The tour waits while one is open and steps aside, with
    // nothing recorded, when one opens over it: being interrupted is not being skipped.
    if (otherDialogOpen()) return { ...CLOSED, available };
    if (!walking) {
      walking = present;
      index = 0;
    }
    // A step whose element left the page gives way to the next one that is there, or the one before.
    const there = (i: number) => (walking![i] ? targetOf(walking![i]) : null);
    const all = [...walking.keys()];
    const order = [...all.filter((i) => i >= index), ...all.filter((i) => i < index).reverse()];
    const at = order.find((i) => there(i));
    if (at === undefined) return { ...CLOSED, available };
    index = at;
    return {
      open: true,
      step: walking[at]!,
      target: there(at),
      index: at,
      count: walking.length,
      isLast: at === walking.length - 1,
      available,
    };
  }

  function refresh(): void {
    const next = compute();
    setReplayable(next.available);
    const same = (Object.keys(next) as (keyof TourSnapshot<S>)[]).every(
      (key) => next[key] === snapshot[key],
    );
    if (same) return;
    const moved = next.target !== snapshot.target;
    snapshot = next;
    if (moved) next.target?.scrollIntoView?.({ block: "nearest" });
    for (const listener of listeners) listener();
  }

  // The screen says it is ready, and only the page says whether a target is there or a dialog is open.
  // Watched only while ready: a screen still loading pays nothing.
  function watch(on: boolean): void {
    if (on === (observer !== null)) return;
    if (!on) {
      observer!.disconnect();
      observer = null;
      return;
    }
    observer = new MutationObserver(refresh);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: WATCHED,
    });
  }

  function end(how: TourEnd["how"]): void {
    if (!snapshot.open) return;
    const ending: TourEnd = {
      how,
      replay: replaying,
      ...(how === "skipped" ? { step: snapshot.index + 1 } : {}),
    };
    closed = true;
    replaying = false;
    refresh();
    onEnd(ending);
  }

  const controller: TourController<S> = {
    update(next) {
      inputs = next;
      watch(next.ready);
      refresh();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    next() {
      if (!snapshot.open) return;
      if (snapshot.isLast) return end("completed");
      index = snapshot.index + 1;
      refresh();
    },
    back() {
      if (!snapshot.open || snapshot.index === 0) return;
      index = snapshot.index - 1;
      // Back from a step lands on the nearest one before it that is on the page.
      while (index > 0 && !targetOf(walking![index]!)) index -= 1;
      refresh();
    },
    skip: () => end("skipped"),
    complete: () => end("completed"),
    replay() {
      replaying = true;
      refresh();
    },
    destroy() {
      watch(false);
      setReplayable(false);
    },
  };
  return controller;
}
