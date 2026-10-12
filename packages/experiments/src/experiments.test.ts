import { describe, expect, it } from "vitest";
import { armOf, defineExperiments } from "./arms.js";
import { compare, sampleSize, splitCheck } from "./stats.js";
import { createVisitors, isPrefetch, isRobot, refusesTracking } from "./visitors.js";

const headers = (values: Record<string, string>) => new Headers(values);
const units = (n: number) => Array.from({ length: n }, (_, i) => `unit-${i}`);

describe("an experiment's definition", () => {
  it("is answered unchanged when it is sound", () => {
    const definitions = { "pricing-2": { arms: { control: 1, annual: 1 }, goals: ["signup"] } };
    expect(defineExperiments(definitions)).toBe(definitions);
  });

  it.each([
    ["an id that is not a name", { "Pricing 2": { arms: { a: 1 }, goals: [] } }, "the id"],
    ["no arm", { x: { arms: {}, goals: [] } }, "no arm"],
    ["an arm named by a number", { x: { arms: { 1: 1 }, goals: [] } }, "the arm 1"],
    ["a weight of zero", { x: { arms: { a: 0 }, goals: [] } }, "the weight of a"],
    ["a weight that is a fraction", { x: { arms: { a: 0.5 }, goals: [] } }, "the weight of a"],
    ["a goal listed twice", { x: { arms: { a: 1 }, goals: ["paid", "paid"] } }, "listed twice"],
    ["a goal named exposure", { x: { arms: { a: 1 }, goals: ["exposure"] } }, "the goal exposure"],
    ["a perArm of zero", { x: { arms: { a: 1 }, goals: [], perArm: 0 } }, "perArm"],
  ])("is refused for %s", (_case, definitions, message) => {
    expect(() => defineExperiments(definitions)).toThrow(message);
  });
});

describe("the arm of a unit", () => {
  const even = { control: 1, annual: 1 };

  it("is the same every time it is asked", () => {
    for (const unit of units(50)) expect(armOf("x", even, unit)).toBe(armOf("x", even, unit));
  });

  it("splits ten thousand units close to the weights", () => {
    const tally = (arms: Record<string, number>) => {
      const seen: Record<string, number> = {};
      for (const unit of units(10_000)) {
        const arm = armOf("x", arms, unit);
        seen[arm] = (seen[arm] ?? 0) + 1;
      }
      return seen;
    };
    expect(tally(even).control).toBeGreaterThan(4800);
    expect(tally(even).control).toBeLessThan(5200);
    const weighted = tally({ control: 3, annual: 1 });
    expect(weighted.control).toBeGreaterThan(7300);
    expect(weighted.control).toBeLessThan(7700);
  });

  it("is cut again by another experiment's id", () => {
    const moved = units(1000).filter((unit) => armOf("x", even, unit) !== armOf("y", even, unit));
    expect(moved.length).toBeGreaterThan(400);
    expect(moved.length).toBeLessThan(600);
  });

  it("is the only arm when there is one", () => {
    expect(armOf("x", { only: 7 }, "anyone")).toBe("only");
  });
});

describe("a visitor's id", () => {
  const visitors = createVisitors({ secret: "s".repeat(32) });

  it("comes back from the cookie that carries it", () => {
    const { id, cookie } = visitors.mint();
    expect(id).toHaveLength(22);
    expect(cookie).toHaveLength(66);
    expect(visitors.read(cookie)).toBe(id);
    expect(visitors.mint().id).not.toBe(id);
  });

  it("is refused under another secret, or with its signature on another id", () => {
    const one = visitors.mint();
    const two = visitors.mint();
    expect(createVisitors({ secret: "t".repeat(32) }).read(one.cookie)).toBeNull();
    expect(visitors.read(`${two.id}.${one.cookie.split(".")[1]}`)).toBeNull();
  });

  it.each([undefined, null, "", "abc", "a".repeat(22), `${"a".repeat(22)}.${"b".repeat(43)}`])(
    "is null for %j",
    (cookie) => {
      expect(visitors.read(cookie)).toBeNull();
    },
  );

  it.each([undefined, "", "short"])("needs a secret of 32 characters: %j", (secret) => {
    expect(() => createVisitors({ secret })).toThrow("32 characters");
  });
});

describe("a request that is never counted", () => {
  const CHROME =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

  it.each([
    ["a person's browser", { "user-agent": CHROME }, false],
    ["a crawler", { "user-agent": "Googlebot/2.1 (+http://www.google.com/bot.html)" }, true],
    ["a link preview", { "user-agent": "WhatsApp/2.23" }, true],
    ["curl", { "user-agent": "curl/8.7.1" }, true],
    ["a headless browser", { "user-agent": CHROME.replace("Chrome", "HeadlessChrome") }, true],
    ["no user agent", {}, true],
    ["a browser behind the CDN", { "user-agent": "Google", "sec-fetch-mode": "navigate" }, false],
    ["a script behind the CDN", { "user-agent": "Google" }, true],
    ["the CDN's own fetch", { "user-agent": "Cloud-CDN-Google" }, true],
  ])("%s", (_case, values: Record<string, string>, robot) => {
    expect(isRobot(headers(values))).toBe(robot);
  });

  it("is a prefetch by either header", () => {
    expect(isPrefetch(headers({ "sec-purpose": "prefetch;prerender" }))).toBe(true);
    expect(isPrefetch(headers({ purpose: "prefetch" }))).toBe(true);
    expect(isPrefetch(headers({}))).toBe(false);
  });

  it("is from someone who asked not to be tracked", () => {
    expect(refusesTracking(headers({ "sec-gpc": "1" }))).toBe(true);
    expect(refusesTracking(headers({ "sec-gpc": "0" }))).toBe(false);
    expect(refusesTracking(headers({}))).toBe(false);
  });
});

describe("the check of the split", () => {
  it("passes an even split that came out near even", () => {
    const check = splitCheck([5040, 4960], [1, 1]);
    expect(check.pValue).toBeCloseTo(0.4237, 3);
    expect(check.mismatch).toBe(false);
  });

  it("knows the chi-square table", () => {
    // 3.841 with one degree of freedom is the 5% point, 5.991 with two.
    expect(splitCheck([1062, 938], [1, 1]).pValue).toBeCloseTo(0.0056, 3);
    expect(splitCheck([10_098, 9902], [1, 1]).pValue).toBeCloseTo(0.1657, 3);
    expect(splitCheck([1000, 1000, 1100], [1, 1, 1]).pValue).toBeCloseTo(0.0397, 3);
  });

  it("flags a split far from its weights", () => {
    expect(splitCheck([5300, 4700], [1, 1]).mismatch).toBe(true);
    expect(splitCheck([7500, 2500], [3, 1]).mismatch).toBe(false);
    expect(splitCheck([5000, 5000], [3, 1]).mismatch).toBe(true);
  });

  it("has nothing to say about one arm, or nobody", () => {
    expect(splitCheck([900], [1])).toEqual({ pValue: 1, mismatch: false });
    expect(splitCheck([0, 0], [1, 1])).toEqual({ pValue: 1, mismatch: false });
  });
});

describe("an arm against the control", () => {
  it("gives the difference, its interval and the p-value", () => {
    const result = compare({ exposed: 1000, converted: 100 }, { exposed: 1000, converted: 130 })!;
    expect(result.difference).toBeCloseTo(0.03, 10);
    expect(result.pValue).toBeCloseTo(0.0355, 3);
    expect(result.interval[0]).toBeCloseTo(0.0021, 3);
    expect(result.interval[1]).toBeCloseTo(0.0579, 3);
  });

  it("is negative when the arm does worse", () => {
    const result = compare({ exposed: 500, converted: 60 }, { exposed: 500, converted: 40 })!;
    expect(result.difference).toBeCloseTo(-0.04, 10);
    expect(result.interval[1]).toBeLessThan(0);
  });

  it("finds no difference between two arms nobody converted in", () => {
    expect(compare({ exposed: 50, converted: 0 }, { exposed: 60, converted: 0 })).toEqual({
      difference: 0,
      interval: [0, 0],
      pValue: 1,
    });
  });

  it("is null while an arm has nobody", () => {
    expect(compare({ exposed: 0, converted: 0 }, { exposed: 10, converted: 1 })).toBeNull();
    expect(compare({ exposed: 10, converted: 1 }, { exposed: 0, converted: 0 })).toBeNull();
  });
});

describe("the units an arm needs", () => {
  it("is 3841 to tell 12% from 10%", () => {
    expect(sampleSize(0.1, 0.02)).toBe(3841);
  });

  it("grows as the difference shrinks, and counts a drop the same way", () => {
    expect(sampleSize(0.1, 0.01)).toBeGreaterThan(4 * sampleSize(0.1, 0.02) - 2000);
    expect(sampleSize(0.12, -0.02)).toBe(3841);
  });

  it.each([
    [0, 0.1],
    [1, 0.1],
    [0.5, 0],
    [0.9, 0.2],
    [0.1, -0.2],
  ])("refuses a baseline of %d with a difference of %d", (baseline, detectable) => {
    expect(() => sampleSize(baseline, detectable)).toThrow("rates between 0 and 1");
  });
});
