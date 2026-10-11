import { describe, expect, it } from "vitest";
import { ces, csat, dueSurvey, nps, parseAnswer } from "./rules.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 11);
const ago = (days: number) => NOW - days * DAY;

describe("the survey due", () => {
  const base = { now: NOW, usingSince: ago(100), lastAsked: {}, triggered: null };

  it("is NPS for someone using the product for 14 days and never asked", () => {
    expect(dueSurvey({ ...base, usingSince: ago(14) })).toBe("nps");
    expect(dueSurvey({ ...base, usingSince: ago(13.9) })).toBeNull();
  });

  it("is the act's survey before NPS", () => {
    expect(dueSurvey({ ...base, triggered: "csat" })).toBe("csat");
    expect(dueSurvey({ ...base, triggered: "ces" })).toBe("ces");
  });

  it("is the act's survey even for someone who arrived today", () => {
    expect(dueSurvey({ ...base, usingSince: NOW, triggered: "ces" })).toBe("ces");
  });

  it("is none within 7 days of any survey shown, whichever it was", () => {
    expect(dueSurvey({ ...base, lastAsked: { csat: ago(6.9) }, triggered: "ces" })).toBeNull();
    expect(dueSurvey({ ...base, lastAsked: { csat: ago(7) }, triggered: "ces" })).toBe("ces");
  });

  it("brings NPS back to the same person after 90 days, not before", () => {
    expect(dueSurvey({ ...base, lastAsked: { nps: ago(89) } })).toBeNull();
    expect(dueSurvey({ ...base, lastAsked: { nps: ago(90) } })).toBe("nps");
  });

  it("follows the rules it is given", () => {
    const rules = { minIntervalDays: 1, npsAfterDaysOfUse: 0, npsEveryDays: 30 };
    expect(dueSurvey({ ...base, usingSince: NOW }, rules)).toBe("nps");
    expect(dueSurvey({ ...base, lastAsked: { nps: ago(29) } }, rules)).toBeNull();
  });
});

describe("an answer", () => {
  it.each([
    ["nps", 0],
    ["nps", 10],
    ["csat", 1],
    ["csat", 5],
    ["ces", 7],
  ])("takes %s %i", (kind, score) => {
    expect(parseAnswer({ kind, score })).toEqual({ kind, score });
  });

  it.each([
    ["a score above the scale", { kind: "csat", score: 6 }],
    ["a score below the scale", { kind: "ces", score: 0 }],
    ["a score that is not whole", { kind: "nps", score: 7.5 }],
    ["a score sent as text", { kind: "nps", score: "9" }],
    ["a survey that does not exist", { kind: "mood", score: 3 }],
    ["a comment that is not text", { kind: "nps", score: 9, comment: 12 }],
    ["a comment past 500 characters", { kind: "nps", score: 9, comment: "a".repeat(501) }],
  ])("refuses %s", (_case, input) => {
    expect(parseAnswer(input)).toBeNull();
  });

  it("trims its comment, and drops one that is only spaces", () => {
    expect(parseAnswer({ kind: "nps", score: 9, comment: "  fast  " })).toEqual({
      kind: "nps",
      score: 9,
      comment: "fast",
    });
    expect(parseAnswer({ kind: "nps", score: 9, comment: "   " })).toEqual({
      kind: "nps",
      score: 9,
    });
  });
});

describe("the scores", () => {
  it("NPS is promoters minus detractors over everyone, from 20 answers", () => {
    const scores = [...Array(12).fill(10), ...Array(4).fill(8), ...Array(4).fill(3)];
    expect(nps(scores)).toEqual({
      answers: 20,
      value: 40,
      promoters: 12,
      passives: 4,
      detractors: 4,
    });
  });

  it("NPS counts 9 as a promoter and 6 as a detractor, and gives no value below 20", () => {
    expect(nps([9, 7, 6])).toEqual({
      answers: 3,
      value: null,
      promoters: 1,
      passives: 1,
      detractors: 1,
    });
  });

  it("CSAT is the percentage who answered 4 or 5", () => {
    expect(csat([5, 4, 3, 1])).toEqual({ answers: 4, value: 50 });
    expect(csat([])).toEqual({ answers: 0, value: null });
  });

  it("CES is the mean, to one decimal", () => {
    expect(ces([7, 6, 6])).toEqual({ answers: 3, value: 6.3 });
    expect(ces([])).toEqual({ answers: 0, value: null });
  });
});
