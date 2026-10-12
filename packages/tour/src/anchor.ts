// Where a tour's card anchors on its target, so the whole card stays on screen.
//
// A positioning library puts the card under the target and flips it above when it does not fit. Over a
// target taller than the room on both sides, neither fits, and the card ends above the top of the
// screen with only its buttons in view.

export type Band = { top: number; bottom: number };

export type AnchorOptions = {
  /** The gap between the target and the card. Give your positioning library the same. Default 4. */
  gap?: number;
  /** How far the card keeps from every edge of the screen. Default 16. */
  margin?: number;
};

/**
 * The vertical band of the target that the card anchors on. A target with room for the whole card
 * below or above it, inside the margins, keeps its own band. Otherwise the band is cut, so the card
 * placed under the cut ends `margin` above the bottom of the screen: over a tall target it covers the
 * lower part and leaves the top in view.
 */
export function anchorBand(
  target: Band,
  cardHeight: number,
  viewportHeight: number,
  { gap = 4, margin = 16 }: AnchorOptions = {},
): Band {
  const below = target.bottom + gap;
  const above = target.top - gap;
  const fitsBelow = below >= margin && below + cardHeight <= viewportHeight - margin;
  const fitsAbove = above <= viewportHeight - margin && above - cardHeight >= margin;
  if (fitsBelow || fitsAbove) return { top: target.top, bottom: target.bottom };
  const cut = viewportHeight - margin - cardHeight - gap;
  return { top: Math.min(target.top, cut), bottom: cut };
}

/** What a positioning library measures in place of an element (Floating UI's virtual element). */
export type VirtualAnchor = {
  contextElement: HTMLElement;
  getBoundingClientRect(): DOMRect;
};

/**
 * The target's box, cut by `anchorBand` against the card's height at that moment. `contextElement`
 * keeps the library following the target on scroll and resize.
 */
export function anchorOf(
  target: HTMLElement,
  cardHeight: () => number,
  options?: AnchorOptions,
): VirtualAnchor {
  return {
    contextElement: target,
    getBoundingClientRect() {
      const box = target.getBoundingClientRect();
      const { top, bottom } = anchorBand(box, cardHeight(), window.innerHeight, options);
      const band = {
        x: box.left,
        y: top,
        left: box.left,
        right: box.right,
        top,
        bottom,
        width: box.width,
        height: bottom - top,
      };
      return { ...band, toJSON: () => band };
    },
  };
}
