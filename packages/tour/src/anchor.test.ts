import { describe, expect, it } from "vitest";
import { anchorBand } from "./anchor.js";

// A screen 800 tall and a card 200 tall, with the default gap of 4 and margin of 16.
describe("the band of the target a card anchors on", () => {
  it("is the target's own when the card fits below it", () => {
    expect(anchorBand({ top: 100, bottom: 140 }, 200, 800)).toEqual({ top: 100, bottom: 140 });
  });

  it("is the target's own when the card fits only above it", () => {
    expect(anchorBand({ top: 600, bottom: 780 }, 200, 800)).toEqual({ top: 600, bottom: 780 });
  });

  it("is cut for a target taller than the room on both sides, so the card ends at the margin", () => {
    // 800 - 16 - 200 - 4: the card under the cut spans 584 to 784.
    expect(anchorBand({ top: 60, bottom: 2600 }, 200, 800)).toEqual({ top: 60, bottom: 580 });
  });

  it("starts no lower than the cut for a target that begins below it", () => {
    expect(anchorBand({ top: 700, bottom: 2600 }, 700, 800)).toEqual({ top: 80, bottom: 80 });
  });

  it("follows the gap and the margin it is given", () => {
    expect(anchorBand({ top: 60, bottom: 2600 }, 200, 800, { gap: 10, margin: 30 })).toEqual({
      top: 60,
      bottom: 560,
    });
  });
});
