// When a person is asked a survey, what an answer may be, and how the three scores are computed.

export type SurveyKind = "nps" | "csat" | "ces";

/** The lowest and highest score each survey takes. */
export const SCALE: Readonly<Record<SurveyKind, readonly [number, number]>> = {
  nps: [0, 10],
  csat: [1, 5],
  ces: [1, 7],
};

export const MAX_COMMENT = 500;

const DAY = 86_400_000;

export type Rules = {
  /** No person is asked two surveys closer together than this. Default 7 days. */
  minIntervalDays: number;
  /** NPS waits until the person has used the product this long. Default 14 days. */
  npsAfterDaysOfUse: number;
  /** NPS comes back to the same person after this long. Default 90 days. */
  npsEveryDays: number;
};

export const DEFAULT_RULES: Rules = {
  minIntervalDays: 7,
  npsAfterDaysOfUse: 14,
  npsEveryDays: 90,
};

export type Situation = {
  now: number;
  /** When the person began using the product. */
  usingSince: number;
  /** When each survey was last shown, answered or dismissed alike. */
  lastAsked: Partial<Record<SurveyKind, number>>;
  /** The survey the act the person just finished calls for, if any. */
  triggered: "csat" | "ces" | null;
};

/**
 * The survey due now, or null. A survey shown counts as asked whether or not it was answered, so a
 * person who dismisses one is left alone for the interval too. An act's survey comes before NPS: it is
 * about what the person did a second ago.
 */
export function dueSurvey(situation: Situation, rules: Rules = DEFAULT_RULES): SurveyKind | null {
  const { now, usingSince, lastAsked, triggered } = situation;
  const latest = Math.max(0, ...Object.values(lastAsked));
  if (now - latest < rules.minIntervalDays * DAY) return null;
  if (triggered) return triggered;
  const npsOpen =
    now - usingSince >= rules.npsAfterDaysOfUse * DAY &&
    now - (lastAsked.nps ?? 0) >= rules.npsEveryDays * DAY;
  return npsOpen ? "nps" : null;
}

export type Answer = { kind: SurveyKind; score: number; comment?: string };

/** The answer as it may be stored, or null: a whole score inside the survey's scale, a comment of at most 500 characters. */
export function parseAnswer(input: {
  kind?: unknown;
  score?: unknown;
  comment?: unknown;
}): Answer | null {
  const { kind, score } = input;
  if (kind !== "nps" && kind !== "csat" && kind !== "ces") return null;
  const [low, high] = SCALE[kind];
  if (typeof score !== "number" || !Number.isInteger(score) || score < low || score > high)
    return null;
  if (input.comment === undefined || input.comment === null) return { kind, score };
  if (typeof input.comment !== "string") return null;
  const comment = input.comment.trim();
  if (comment.length > MAX_COMMENT) return null;
  return comment ? { kind, score, comment } : { kind, score };
}

/** Below this many answers an NPS is noise, and none is given. */
export const NPS_MIN_ANSWERS = 20;

export type Nps = {
  answers: number;
  /** Promoters minus detractors, as a share of all answers, from -100 to 100. Null below 20 answers. */
  value: number | null;
  promoters: number;
  passives: number;
  detractors: number;
};

export type Index = { answers: number; value: number | null };

/** Net Promoter Score: 9 and 10 promote, 0 to 6 detract. */
export function nps(scores: readonly number[]): Nps {
  const promoters = scores.filter((s) => s >= 9).length;
  const detractors = scores.filter((s) => s <= 6).length;
  const answers = scores.length;
  return {
    answers,
    value:
      answers >= NPS_MIN_ANSWERS ? Math.round(((promoters - detractors) / answers) * 100) : null,
    promoters,
    passives: answers - promoters - detractors,
    detractors,
  };
}

/** Customer Satisfaction: the percentage who answered 4 or 5. */
export function csat(scores: readonly number[]): Index {
  if (scores.length === 0) return { answers: 0, value: null };
  const satisfied = scores.filter((s) => s >= 4).length;
  return { answers: scores.length, value: Math.round((satisfied / scores.length) * 100) };
}

/** Customer Effort Score: the mean of the answers, to one decimal. */
export function ces(scores: readonly number[]): Index {
  if (scores.length === 0) return { answers: 0, value: null };
  const mean = scores.reduce((sum, s) => sum + s, 0) / scores.length;
  return { answers: scores.length, value: Math.round(mean * 10) / 10 };
}
