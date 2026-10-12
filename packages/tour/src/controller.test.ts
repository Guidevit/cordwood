// @vitest-environment jsdom
import { createElement, useRef } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { anchorOf } from "./anchor.js";
import {
  canReplay,
  createTourController,
  focusTarget,
  replayTour,
  type TourEnd,
} from "./controller.js";
import { useCanReplay, useTour, useTourAnchor } from "./react.js";

type S = { target: string; title: string };
const STEPS: S[] = [
  { target: "list", title: "The list" },
  { target: "filters", title: "The filters" },
  { target: "export", title: "Export" },
];

/** Puts an element marked for a step on the page. */
function mark(target: string, tag = "section"): HTMLElement {
  const element = document.createElement(tag);
  element.setAttribute("data-tour", target);
  document.body.append(element);
  return element;
}

/** MutationObserver callbacks are microtasks. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** `null` is an answer not known yet. */
function tourOf(seen: boolean | null = false, steps: S[] = STEPS) {
  const ends: TourEnd[] = [];
  const tour = createTourController<S>((end) => ends.push(end));
  const changes = vi.fn();
  tour.subscribe(changes);
  tour.update({ steps, ready: true, seen: seen ?? undefined });
  made.push(tour);
  return { tour, ends, changes };
}

const made: { destroy(): void }[] = [];
beforeEach(() => {
  document.body.replaceChildren();
});
afterEach(() => {
  for (const tour of made.splice(0)) tour.destroy();
});

describe("when a tour opens", () => {
  it("opens on the first step of a tour never seen, on a ready screen with its targets", () => {
    const list = mark("list");
    mark("filters");
    mark("export");
    const { tour } = tourOf();
    expect(tour.getSnapshot()).toEqual({
      open: true,
      step: STEPS[0],
      target: list,
      index: 0,
      count: 3,
      isLast: false,
      available: true,
    });
  });

  it.each([
    ["seen", true],
    ["not known yet, or a read that failed", null],
  ])("stays closed for a tour %s", (_case, seen) => {
    mark("list");
    const { tour } = tourOf(seen);
    expect(tour.getSnapshot()).toMatchObject({ open: false, available: true });
  });

  it("stays closed while the screen is not ready, and watches nothing", async () => {
    const { tour, changes } = tourOf();
    tour.update({ steps: STEPS, ready: false, seen: false });
    mark("list");
    await settle();
    expect(tour.getSnapshot().open).toBe(false);
    expect(changes).not.toHaveBeenCalled();
  });

  it("opens when a target comes onto a ready screen that had none", async () => {
    const { tour } = tourOf();
    expect(tour.getSnapshot()).toMatchObject({ open: false, available: false });
    const filters = mark("filters");
    await settle();
    expect(tour.getSnapshot()).toMatchObject({ open: true, target: filters, count: 1, isLast: true });
  });

  it("leaves out a step whose element is not on the page", () => {
    mark("list");
    mark("export");
    const { tour } = tourOf();
    expect(tour.getSnapshot().count).toBe(2);
    tour.next();
    expect(tour.getSnapshot()).toMatchObject({ step: STEPS[2], index: 1, isLast: true });
  });

  it("escapes a target's name, so one with a quote selects nothing else", () => {
    mark("list");
    const { tour } = tourOf(false, [{ target: 'x"], [data-tour="list', title: "" }]);
    expect(tour.getSnapshot().open).toBe(false);
  });
});

describe("another dialog", () => {
  it.each([
    ["a role=dialog", () => Object.assign(document.createElement("div"), { role: "dialog" })],
    ["an alert dialog", () => Object.assign(document.createElement("div"), { role: "alertdialog" })],
    [
      "a native dialog",
      () => {
        const dialog = document.createElement("dialog");
        dialog.setAttribute("open", "");
        return dialog;
      },
    ],
  ])("holds the tour back while %s is open, and lets it open after", async (_case, make) => {
    mark("list");
    const dialog = make();
    document.body.append(dialog);
    const { tour } = tourOf();
    expect(tour.getSnapshot()).toMatchObject({ open: false, available: true });
    dialog.remove();
    await settle();
    expect(tour.getSnapshot().open).toBe(true);
  });

  it("makes an open tour step aside with nothing recorded, and return at its step", async () => {
    mark("list");
    mark("filters");
    const { tour, ends } = tourOf();
    tour.next();
    const sheet = document.createElement("div");
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("data-state", "open");
    document.body.append(sheet);
    await settle();
    expect(tour.getSnapshot().open).toBe(false);
    expect(ends).toEqual([]);
    // Animating out is already closed.
    sheet.setAttribute("data-state", "closed");
    await settle();
    expect(tour.getSnapshot()).toMatchObject({ open: true, index: 1 });
  });

  it("is never the tour's own card, or a dialog that is hidden", () => {
    mark("list");
    const card = document.createElement("div");
    card.setAttribute("role", "dialog");
    card.setAttribute("data-tour-card", "");
    const hidden = document.createElement("div");
    hidden.setAttribute("role", "dialog");
    hidden.hidden = true;
    document.body.append(card, hidden, document.createElement("dialog"));
    expect(tourOf().tour.getSnapshot().open).toBe(true);
  });
});

describe("moving between steps", () => {
  beforeEach(() => {
    for (const { target } of STEPS) mark(target);
  });

  it("goes forward and back, and tells whoever listens once per move", () => {
    const { tour, changes } = tourOf();
    changes.mockClear();
    tour.next();
    expect(tour.getSnapshot()).toMatchObject({ index: 1, step: STEPS[1] });
    tour.back();
    tour.back();
    expect(tour.getSnapshot().index).toBe(0);
    expect(changes).toHaveBeenCalledTimes(2);
  });

  it("keeps the same snapshot object while nothing changes", () => {
    const { tour } = tourOf();
    const before = tour.getSnapshot();
    tour.update({ steps: STEPS, ready: true, seen: false });
    expect(tour.getSnapshot()).toBe(before);
  });

  it("stays on its step when the screen hands the same steps in a new array", () => {
    const { tour } = tourOf();
    tour.next();
    tour.update({ steps: STEPS.map((step) => ({ ...step })), ready: true, seen: false });
    expect(tour.getSnapshot()).toMatchObject({ index: 1, step: STEPS[1] });
  });

  it("moves to the next step when the current one's element leaves the page", async () => {
    const { tour } = tourOf();
    tour.next();
    document.querySelector('[data-tour="filters"]')!.remove();
    await settle();
    expect(tour.getSnapshot()).toMatchObject({ index: 2, step: STEPS[2] });
    document.querySelector('[data-tour="export"]')!.remove();
    await settle();
    expect(tour.getSnapshot()).toMatchObject({ index: 0, step: STEPS[0] });
  });

  it("goes back past a step whose element left", async () => {
    const { tour } = tourOf();
    tour.next();
    tour.next();
    document.querySelector('[data-tour="filters"]')!.remove();
    await settle();
    tour.back();
    expect(tour.getSnapshot().index).toBe(0);
  });

  it("brings each step's target into view", () => {
    const scrolled: string[] = [];
    for (const element of document.querySelectorAll<HTMLElement>("[data-tour]"))
      element.scrollIntoView = () => scrolled.push(element.dataset.tour!);
    const { tour } = tourOf();
    tour.next();
    expect(scrolled).toEqual(["list", "filters"]);
  });
});

describe("how a tour ends", () => {
  beforeEach(() => {
    for (const { target } of STEPS) mark(target);
  });

  it("is completed by next on the last step", () => {
    const { tour, ends } = tourOf();
    tour.next();
    tour.next();
    tour.next();
    expect(ends).toEqual([{ how: "completed", replay: false }]);
    expect(tour.getSnapshot()).toMatchObject({ open: false, available: true });
  });

  it("is skipped at the step the person was on, counted from 1", () => {
    const { tour, ends } = tourOf();
    tour.next();
    tour.skip();
    expect(ends).toEqual([{ how: "skipped", step: 2, replay: false }]);
  });

  it("stays closed after it ends, before the server's answer arrives", () => {
    const { tour, ends } = tourOf();
    tour.complete();
    tour.update({ steps: STEPS, ready: true, seen: false });
    expect(tour.getSnapshot().open).toBe(false);
    tour.skip();
    tour.next();
    expect(ends).toHaveLength(1);
  });
});

describe("opening a tour again", () => {
  it("opens a tour already seen from its first step, and says the ending is a replay's", () => {
    for (const { target } of STEPS) mark(target);
    const { tour, ends } = tourOf(true);
    expect(canReplay()).toBe(true);
    replayTour();
    expect(tour.getSnapshot()).toMatchObject({ open: true, index: 0 });
    tour.skip();
    expect(ends).toEqual([{ how: "skipped", step: 1, replay: true }]);
    expect(tour.getSnapshot().open).toBe(false);
  });

  it("is offered only while a tour could open on the screen", async () => {
    const { tour } = tourOf(true);
    expect(canReplay()).toBe(false);
    replayTour();
    const list = mark("list");
    await settle();
    expect(canReplay()).toBe(true);
    list.remove();
    await settle();
    expect(canReplay()).toBe(false);
    mark("list");
    await settle();
    tour.destroy();
    expect(canReplay()).toBe(false);
  });
});

describe("giving the focus back", () => {
  it("makes a section focusable by script only, and leaves a button as it is", () => {
    const section = mark("list");
    const button = mark("export", "button");
    focusTarget(section);
    expect(section.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(section);
    focusTarget(button);
    expect(button.hasAttribute("tabindex")).toBe(false);
    expect(document.activeElement).toBe(button);
    expect(() => focusTarget(null)).not.toThrow();
  });
});

describe("the anchor of a target", () => {
  it("measures the target's box cut against the card's height at that moment", () => {
    const target = mark("list");
    target.getBoundingClientRect = () => new DOMRect(40, 60, 900, 2540);
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    let card = 0;
    const anchor = anchorOf(target, () => card);
    expect(anchor.contextElement).toBe(target);
    card = 200;
    expect(anchor.getBoundingClientRect()).toMatchObject({
      left: 40,
      right: 940,
      top: 60,
      bottom: 580,
      height: 520,
      width: 900,
    });
  });
});

describe("the React hooks", () => {
  it("render the tour, follow its moves, and keep one anchor per target", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    for (const { target } of STEPS) mark(target);
    const ends: TourEnd[] = [];
    const anchors = new Set<unknown>();
    let tour!: ReturnType<typeof useTour<S>>;
    let replayable = false;
    function Screen() {
      // A new array on every render, as a screen that builds its steps does.
      tour = useTour({ steps: [...STEPS], ready: true, seen: false, onEnd: (end) => ends.push(end) });
      replayable = useCanReplay();
      const card = useRef<HTMLElement | null>(null);
      anchors.add(useTourAnchor(tour.target, card));
      return createElement("p", null, tour.step?.title ?? "closed");
    }
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(Screen)));
    expect(host.textContent).toBe("The list");
    expect(replayable).toBe(true);
    await act(async () => tour.next());
    expect(host.textContent).toBe("The filters");
    await act(async () => tour.skip());
    expect(host.textContent).toBe("closed");
    expect(ends).toEqual([{ how: "skipped", step: 2, replay: false }]);
    // Closed, the first target, the second, closed again.
    expect(anchors.size).toBe(3);
    await act(async () => root.unmount());
    expect(canReplay()).toBe(false);
  });
});
