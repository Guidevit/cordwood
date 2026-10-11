// Runs against the Firestore emulator: `pnpm test` starts it.
import { randomUUID } from "node:crypto";
import { firestore as adminFirestore, tenantRef } from "@cordwood/firebase";
import { describe, expect, it } from "vitest";
import { createSurveys } from "./index.js";

if (!process.env.FIRESTORE_EMULATOR_HOST)
  throw new Error("the Firestore emulator is not running: use `pnpm test`");

const db = adminFirestore();
const surveys = createSurveys({
  firestore: db,
  triggers: { exported: "csat", imported: "ces" },
});
const id = () => randomUUID().replaceAll("-", "").slice(0, 20);
const DAY = 86_400_000;
const NOW = new Date("2026-10-11T12:00:00Z");
const at = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * DAY);
const person = () => ({ tenantId: id(), userId: id(), usingSince: at(100) });
const answersOf = (tenantId: string) =>
  tenantRef(db, tenantId).collection("survey_answers").get();

describe("asking", () => {
  it("answers the survey due and records it as shown, so a second ask is null", async () => {
    const who = person();
    expect(await surveys.ask({ ...who, now: NOW })).toBe("nps");
    expect(await surveys.ask({ ...who, now: NOW })).toBeNull();
    expect(await surveys.ask({ ...who, act: "exported", now: NOW })).toBeNull();
  });

  it("asks the act's survey, and holds the next one for a week", async () => {
    const who = person();
    expect(await surveys.ask({ ...who, act: "imported", now: at(8) })).toBe("ces");
    expect(await surveys.ask({ ...who, act: "exported", now: at(2) })).toBeNull();
    expect(await surveys.ask({ ...who, act: "exported", now: NOW })).toBe("csat");
  });

  it("does not ask NPS of someone who arrived last week", async () => {
    const who = { ...person(), usingSince: at(7) };
    expect(await surveys.ask({ ...who, now: NOW })).toBeNull();
    expect(await surveys.ask({ ...who, act: "exported", now: NOW })).toBe("csat");
  });

  it("asks one of two requests that arrive at the same moment", async () => {
    const who = person();
    const both = await Promise.all([
      surveys.ask({ ...who, now: NOW }),
      surveys.ask({ ...who, now: NOW }),
    ]);
    expect(both.filter((kind) => kind === "nps")).toHaveLength(1);
  });

  it("keeps each person's dates apart", async () => {
    const tenantId = id();
    const one = { tenantId, userId: id(), usingSince: at(100) };
    const two = { tenantId, userId: id(), usingSince: at(100) };
    expect(await surveys.ask({ ...one, now: NOW })).toBe("nps");
    expect(await surveys.ask({ ...two, now: NOW })).toBe("nps");
  });
});

describe("answering", () => {
  it("stores the answer with no user id in it", async () => {
    const who = person();
    await surveys.ask({ ...who, now: NOW });
    expect(
      await surveys.answer({ ...who, kind: "nps", score: 9, comment: " quick to learn ", now: NOW }),
    ).toBe("stored");
    const stored = await answersOf(who.tenantId);
    expect(stored.size).toBe(1);
    const data = stored.docs[0]!.data();
    expect({ ...data, at: data.at.toDate() }).toEqual({
      kind: "nps",
      score: 9,
      comment: "quick to learn",
      at: NOW,
    });
    expect(JSON.stringify(data)).not.toContain(who.userId);
    expect(stored.docs[0]!.id).not.toBe(who.userId);
  });

  it("takes one answer per time asked", async () => {
    const who = person();
    await surveys.ask({ ...who, now: NOW });
    expect(await surveys.answer({ ...who, kind: "nps", score: 10, now: NOW })).toBe("stored");
    expect(await surveys.answer({ ...who, kind: "nps", score: 10, now: NOW })).toBe("not_asked");
    expect((await answersOf(who.tenantId)).size).toBe(1);
  });

  it("refuses an answer nobody asked for", async () => {
    const who = person();
    expect(await surveys.answer({ ...who, kind: "nps", score: 9, now: NOW })).toBe("not_asked");
    await surveys.ask({ ...who, act: "exported", now: NOW });
    // Asked CSAT, answering NPS.
    expect(await surveys.answer({ ...who, kind: "nps", score: 9, now: NOW })).toBe("not_asked");
    expect((await answersOf(who.tenantId)).size).toBe(0);
  });

  it("refuses an answer more than a day after the question", async () => {
    const who = person();
    await surveys.ask({ ...who, now: at(1.1) });
    expect(await surveys.answer({ ...who, kind: "nps", score: 9, now: NOW })).toBe("not_asked");
  });

  it("takes a new answer once the survey is asked again", async () => {
    const who = { ...person(), usingSince: at(200) };
    expect(await surveys.ask({ ...who, now: at(91) })).toBe("nps");
    expect(await surveys.answer({ ...who, kind: "nps", score: 3, now: at(91) })).toBe("stored");
    expect(await surveys.ask({ ...who, now: NOW })).toBe("nps");
    expect(await surveys.answer({ ...who, kind: "nps", score: 9, now: NOW })).toBe("stored");
    expect((await answersOf(who.tenantId)).size).toBe(2);
  });

  it("answers `invalid` for a score outside the scale, and stores nothing", async () => {
    const who = person();
    await surveys.ask({ ...who, act: "exported", now: NOW });
    expect(await surveys.answer({ ...who, kind: "csat", score: 6, now: NOW })).toBe("invalid");
    expect((await answersOf(who.tenantId)).size).toBe(0);
  });
});

describe("the results", () => {
  /** A tenant with answers written straight to its collection, each `daysAgo` old. */
  async function tenantWithAnswers(rows: [kind: string, score: number, daysAgo: number, comment?: string][]) {
    const tenantId = id();
    const answers = tenantRef(db, tenantId).collection("survey_answers");
    await Promise.all(
      rows.map(([kind, score, daysAgo, comment]) =>
        answers.add({ kind, score, at: at(daysAgo), ...(comment ? { comment } : {}) }),
      ),
    );
    return tenantId;
  }

  it("score one tenant's answers inside the period, newest comment first", async () => {
    const tenantId = await tenantWithAnswers([
      ["csat", 5, 1, "the export saved my afternoon"],
      ["csat", 4, 2],
      ["csat", 2, 3, "too many steps"],
      ["ces", 6, 4],
      ["ces", 7, 5],
      ["nps", 9, 6],
      // Outside a 30-day period.
      ["csat", 1, 31, "an old complaint"],
    ]);
    const results = await surveys.results({ days: 30, tenantId, now: NOW });
    expect(results.csat).toEqual({ answers: 3, value: 67 });
    expect(results.ces).toEqual({ answers: 2, value: 6.5 });
    expect(results.nps).toMatchObject({ answers: 1, value: null, promoters: 1 });
    expect(results.comments).toEqual([
      { kind: "csat", score: 5, text: "the export saved my afternoon", day: "2026-10-10" },
      { kind: "csat", score: 2, text: "too many steps", day: "2026-10-08" },
    ]);
  });

  it("limit the comments to the number asked for", async () => {
    const tenantId = await tenantWithAnswers([
      ["csat", 5, 1, "one"],
      ["csat", 5, 2, "two"],
      ["csat", 5, 3, "three"],
    ]);
    const { comments } = await surveys.results({ days: 30, tenantId, comments: 2, now: NOW });
    expect(comments.map((c) => c.text)).toEqual(["one", "two"]);
  });

  it("read across tenants, and never a collection of the same name outside one", async () => {
    // Its own instant far from every other test's, so the range holds these rows only.
    const then = new Date("2031-03-03T12:00:00Z");
    const write = (tenantId: string, score: number) =>
      tenantRef(db, tenantId).collection("survey_answers").add({ kind: "ces", score, at: then });
    await Promise.all([write(id(), 7), write(id(), 5)]);
    await db
      .collection("elsewhere")
      .doc(id())
      .collection("survey_answers")
      .add({ kind: "ces", score: 1, at: then });
    const results = await surveys.results({
      days: 1,
      now: new Date(then.getTime() + 60_000),
    });
    expect(results.ces).toEqual({ answers: 2, value: 6 });
  });

  it("are empty with no answer", async () => {
    const results = await surveys.results({ days: 30, tenantId: id(), now: NOW });
    expect(results).toEqual({
      nps: { answers: 0, value: null, promoters: 0, passives: 0, detractors: 0 },
      csat: { answers: 0, value: null },
      ces: { answers: 0, value: null },
      comments: [],
    });
  });
});
