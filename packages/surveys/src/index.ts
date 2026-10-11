// Where survey answers and each person's last-asked dates are stored, and how they are read back.
import { tenantRef } from "@cordwood/firebase";
import { Timestamp, type Firestore } from "firebase-admin/firestore";
import {
  DEFAULT_RULES,
  ces,
  csat,
  dueSurvey,
  nps,
  parseAnswer,
  type Index,
  type Nps,
  type Rules,
  type SurveyKind,
} from "./rules.js";

/** Each person's survey dates: tenants/{tenantId}/survey_state/{userId}. */
export const STATE = "survey_state";
/** The answers: tenants/{tenantId}/survey_answers/{auto id}. */
export const ANSWERS = "survey_answers";

const DAY = 86_400_000;
/** How long after being asked a person may still answer. */
const ANSWER_WINDOW = DAY;

type Dates = Partial<Record<SurveyKind, Timestamp>>;

export type SurveysConfig<A extends string> = {
  firestore: Firestore;
  /**
   * The acts that call for a survey, each with the one it calls for: `csat` after something the person
   * may be pleased with (an export), `ces` after something that took effort (an import).
   */
  triggers?: Readonly<Record<A, "csat" | "ces">>;
  rules?: Partial<Rules>;
};

export type AskInput<A extends string> = {
  tenantId: string;
  userId: string;
  /** When the person began using the product: NPS waits on it. */
  usingSince: Date;
  /** The act the person just finished, when it is one of the triggers. */
  act?: A;
  now?: Date;
};

export type AnswerInput = {
  tenantId: string;
  userId: string;
  kind: unknown;
  score: unknown;
  comment?: unknown;
  now?: Date;
};

/** `not_asked`: the person was not asked this survey in the last day, or already answered it. */
export type Answered = "stored" | "not_asked" | "invalid";

export type Results = {
  nps: Nps;
  csat: Index;
  ces: Index;
  /** The latest comments, newest first, with nothing that says who wrote them. */
  comments: { kind: SurveyKind; score: number; text: string; day: string }[];
};

export type Surveys<A extends string> = {
  /**
   * The survey due for this person now, or null. It is recorded as shown in the same step, so asking
   * again a second later answers null: call it once, when you are about to show the question.
   */
  ask(input: AskInput<A>): Promise<SurveyKind | null>;
  /**
   * Stores the answer, with no user id and no name in it, only when the person was asked that survey
   * in the last day and has not answered it yet. So one person cannot tilt a score.
   */
  answer(input: AnswerInput): Promise<Answered>;
  /**
   * The three scores over the last `days`, across every tenant or for one. Reading across tenants
   * needs the index this package ships.
   */
  results(options: {
    days: number;
    tenantId?: string;
    comments?: number;
    now?: Date;
  }): Promise<Results>;
};

type Stored = { kind: SurveyKind; score: number; comment?: string; at: Timestamp };

export function createSurveys<A extends string = never>(config: SurveysConfig<A>): Surveys<A> {
  const { firestore } = config;
  const rules: Rules = { ...DEFAULT_RULES, ...config.rules };
  const triggers = (config.triggers ?? {}) as Readonly<Record<string, "csat" | "ces">>;
  const stateOf = (tenantId: string, userId: string) =>
    tenantRef(firestore, tenantId).collection(STATE).doc(userId);

  async function ask(input: AskInput<A>): Promise<SurveyKind | null> {
    const now = (input.now ?? new Date()).getTime();
    const state = stateOf(input.tenantId, input.userId);
    const triggered = input.act !== undefined ? (triggers[input.act] ?? null) : null;
    return firestore.runTransaction(async (tx) => {
      const asked = ((await tx.get(state)).get("asked") ?? {}) as Dates;
      const lastAsked = Object.fromEntries(
        Object.entries(asked).map(([kind, at]) => [kind, at.toMillis()]),
      );
      const kind = dueSurvey(
        { now, usingSince: input.usingSince.getTime(), lastAsked, triggered },
        rules,
      );
      if (kind)
        tx.set(state, { asked: { [kind]: Timestamp.fromMillis(now) } }, { merge: true });
      return kind;
    });
  }

  async function answer(input: AnswerInput): Promise<Answered> {
    const parsed = parseAnswer(input);
    if (!parsed) return "invalid";
    const now = (input.now ?? new Date()).getTime();
    const tenant = tenantRef(firestore, input.tenantId);
    const state = tenant.collection(STATE).doc(input.userId);
    return firestore.runTransaction(async (tx) => {
      const data = (await tx.get(state)).data() as { asked?: Dates; answered?: Dates } | undefined;
      const asked = data?.asked?.[parsed.kind]?.toMillis();
      const answered = data?.answered?.[parsed.kind]?.toMillis() ?? 0;
      if (!asked || now - asked > ANSWER_WINDOW || answered >= asked) return "not_asked";
      const at = Timestamp.fromMillis(now);
      tx.set(state, { answered: { [parsed.kind]: at } }, { merge: true });
      // The path names the tenant and nothing names the person: an answer is unnamed. It is not
      // anonymous, since its instant matches the one on the person's own state document.
      tx.create(tenant.collection(ANSWERS).doc(), { ...parsed, at });
      return "stored";
    });
  }

  async function results(options: {
    days: number;
    tenantId?: string;
    comments?: number;
    now?: Date;
  }): Promise<Results> {
    const now = (options.now ?? new Date()).getTime();
    // The period bounds the read: unbounded, it would read every answer ever given.
    const since = Timestamp.fromMillis(now - options.days * DAY);
    const source = options.tenantId
      ? tenantRef(firestore, options.tenantId).collection(ANSWERS)
      : firestore.collectionGroup(ANSWERS);
    const found = await source
      .where("at", ">", since)
      .where("at", "<=", Timestamp.fromMillis(now))
      .get();
    const read = found.docs
      // A collection group matches any collection of that name: only a tenant's own counts.
      .filter((doc) => doc.ref.parent.parent?.parent.id === "tenants")
      .map((doc) => doc.data() as Stored)
      .sort((a, b) => b.at.toMillis() - a.at.toMillis());
    const scores = (kind: SurveyKind) => read.filter((a) => a.kind === kind).map((a) => a.score);
    return {
      nps: nps(scores("nps")),
      csat: csat(scores("csat")),
      ces: ces(scores("ces")),
      comments: read
        .filter((a) => a.comment)
        .slice(0, options.comments ?? 10)
        .map((a) => ({
          kind: a.kind,
          score: a.score,
          text: a.comment!,
          day: a.at.toDate().toISOString().slice(0, 10),
        })),
    };
  }

  return { ask, answer, results };
}

export {
  DEFAULT_RULES,
  MAX_COMMENT,
  NPS_MIN_ANSWERS,
  SCALE,
  ces,
  csat,
  dueSurvey,
  nps,
  parseAnswer,
  type Answer,
  type Index,
  type Nps,
  type Rules,
  type Situation,
  type SurveyKind,
} from "./rules.js";
