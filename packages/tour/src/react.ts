"use client";
// The controller as React hooks. No markup: the card is your component library's popover.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { anchorOf, type AnchorOptions, type VirtualAnchor } from "./anchor.js";
import {
  canReplay,
  closedSnapshot,
  createTourController,
  subscribeCanReplay,
  type Step,
  type TourEnd,
  type TourInputs,
  type TourSnapshot,
} from "./controller.js";

export type Tour<S extends Step> = TourSnapshot<S> & {
  next(): void;
  back(): void;
  skip(): void;
  complete(): void;
};

/**
 * A screen's tour. It opens on the first visit once the screen is `ready` and a target is on the page,
 * waits while another dialog is open, and walks the steps whose targets are there. `onEnd` is where
 * you tell the server, unless `replay` is true.
 */
export function useTour<S extends Step>(
  options: TourInputs<S> & { onEnd: (end: TourEnd) => void },
): Tour<S> {
  const onEnd = useRef(options.onEnd);
  const [controller] = useState(() => createTourController<S>((end) => onEnd.current(end)));
  const { steps, ready, seen } = options;
  // After every render: the controller compares, and new data on the screen may have moved a target.
  useEffect(() => {
    onEnd.current = options.onEnd;
    controller.update({ steps, ready, seen });
  });
  useEffect(() => () => controller.destroy(), [controller]);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, closedSnapshot<S>);
  return useMemo(
    () => ({
      ...snapshot,
      next: controller.next,
      back: controller.back,
      skip: controller.skip,
      complete: controller.complete,
    }),
    [snapshot, controller],
  );
}

/** Whether the screen on show has a tour that `replayTour` would open. */
export function useCanReplay(): boolean {
  return useSyncExternalStore(subscribeCanReplay, canReplay, () => false);
}

/**
 * What the card anchors on, as a ref: Radix's `virtualRef`, or `.current` for Floating UI. One object
 * per target, since a library re-anchors whenever the anchor's identity changes.
 */
export function useTourAnchor(
  target: HTMLElement | null,
  card: { current: HTMLElement | null },
  options?: AnchorOptions,
): { current: VirtualAnchor } | null {
  const { gap, margin } = options ?? {};
  return useMemo(
    () =>
      target
        ? { current: anchorOf(target, () => card.current?.offsetHeight ?? 0, { gap, margin }) }
        : null,
    [target, card, gap, margin],
  );
}

export type Box = { top: number; left: number; width: number; height: number };

const sameBox = (a: Box | null, b: Box) =>
  a !== null && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height;

/**
 * The target's box on the screen, for the ring you draw around it. Measured on every frame, which
 * covers scroll and resize too: new data can move the target with neither. The state changes only
 * when the box does, so a ring at rest renders nothing.
 */
export function useTargetBox(target: HTMLElement | null): Box | null {
  const [box, setBox] = useState<Box | null>(null);
  useLayoutEffect(() => {
    if (!target) return setBox(null);
    let frame = 0;
    const measure = () => {
      const { top, left, width, height } = target.getBoundingClientRect();
      const now = { top, left, width, height };
      setBox((before) => (sameBox(before, now) ? before : now));
      frame = requestAnimationFrame(measure);
    };
    measure();
    return () => cancelAnimationFrame(frame);
  }, [target]);
  return box;
}

export { anchorBand, anchorOf, type AnchorOptions, type Band, type VirtualAnchor } from "./anchor.js";
export {
  CARD_ATTRIBUTE,
  createTourController,
  focusTarget,
  otherDialogOpen,
  replayTour,
  type Step,
  type TourController,
  type TourEnd,
  type TourInputs,
  type TourSnapshot,
} from "./controller.js";
