// Runs against the Auth and Firestore emulators: `pnpm test` starts both.
import { randomUUID } from "node:crypto";
import { auth as adminAuth, firestore as adminFirestore, tenantRef } from "@cordwood/firebase";
import { beforeEach, describe, expect, it } from "vitest";
import { SendStopped, createChangelog, type Delivery } from "./index.js";

if (!process.env.FIREBASE_AUTH_EMULATOR_HOST || !process.env.FIRESTORE_EMULATOR_HOST)
  throw new Error("the emulators are not running: use `pnpm test`");

const db = adminFirestore();
const auth = adminAuth();
type Note = { version: string; title: string };
const NOTES: Note[] = [
  { version: "2.10.0", title: "Saved filters" },
  { version: "2.9.0", title: "Dark theme" },
];
const changelogOf = (notes: Note[] = NOTES) =>
  createChangelog({ firestore: db, auth, notes, origin: "https://app.example.com" });
const changelog = changelogOf();

const id = () => randomUUID().replaceAll("-", "").slice(0, 20);
const T0 = new Date("2026-10-01T12:00:00Z");
const later = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

/** A person with an account in a tenant, as `@cordwood/auth` leaves one. */
async function person(options: { verified?: boolean; disabled?: boolean; tenantId?: string } = {}) {
  const tenantId = options.tenantId ?? id();
  const email = `${id()}@example.com`;
  const account = await auth.createUser({
    email,
    emailVerified: options.verified ?? true,
    disabled: options.disabled ?? false,
  });
  await auth.setCustomUserClaims(account.uid, { tenant: tenantId, role: "member" });
  return { tenantId, userId: account.uid, email };
}

const stored = async (who: { tenantId: string; userId: string }) =>
  (await tenantRef(db, who.tenantId).collection("changelog_state").doc(who.userId).get()).data();

/** A sender that records what it was handed and fails as the test says. */
function mailbox(failFor: (to: string, n: number) => unknown = () => null) {
  const delivered: Delivery<Note>[] = [];
  let attempts = 0;
  const deliver = async (delivery: Delivery<Note>) => {
    attempts += 1;
    const failure = failFor(delivery.to, attempts);
    if (failure) throw failure;
    delivered.push(delivery);
  };
  return { deliver, delivered, attempts: () => attempts };
}

// A run reads every tenant's subscribers, so each test starts from none.
beforeEach(async () => {
  const everyone = await db.collectionGroup("changelog_state").get();
  await Promise.all(everyone.docs.map((doc) => doc.ref.delete()));
});

describe("the notes inside the app", () => {
  it("are unread until the person opens them, and unread again at the next release", async () => {
    const who = await person();
    expect(await changelog.status(who.tenantId, who.userId)).toEqual({
      latest: NOTES[0],
      unread: true,
    });
    await changelog.markRead(who.tenantId, who.userId);
    expect((await changelog.status(who.tenantId, who.userId)).unread).toBe(false);

    const next = changelogOf([{ version: "2.11.0", title: "Kanban" }, ...NOTES]);
    expect(await next.status(who.tenantId, who.userId)).toEqual({
      latest: { version: "2.11.0", title: "Kanban" },
      unread: true,
    });
  });

  it("stay read after a rollback to the release before", async () => {
    const who = await person();
    await changelog.markRead(who.tenantId, who.userId);
    const rolledBack = changelogOf([NOTES[1]!]);
    expect((await rolledBack.status(who.tenantId, who.userId)).unread).toBe(false);
  });

  it("are read per person: a colleague still has them unread", async () => {
    const one = await person();
    const two = await person({ tenantId: one.tenantId });
    await changelog.markRead(one.tenantId, one.userId);
    expect((await changelog.status(two.tenantId, two.userId)).unread).toBe(true);
  });

  it("have nothing to show before the first release", async () => {
    const who = await person();
    const empty = changelogOf([]);
    expect(await empty.status(who.tenantId, who.userId)).toEqual({ latest: null, unread: false });
    await empty.markRead(who.tenantId, who.userId);
    expect(await stored(who)).toBeUndefined();
  });
});

describe("a person's answer about the e-mails", () => {
  it("reads as never given before any answer", async () => {
    const who = await person();
    expect(await changelog.subscription(who.tenantId, who.userId)).toEqual({ on: false, at: null });
  });

  it("is recorded with its day, its source and a way out", async () => {
    const who = await person();
    expect(await changelog.subscribe(who.tenantId, who.userId, true, "settings", T0)).toEqual({
      on: true,
      at: T0,
    });
    const { email } = (await stored(who))!;
    expect(email).toMatchObject({ on: true, source: "settings", sent: "2.10.0" });
    expect(email.at.toDate()).toEqual(T0);
    expect(email.exit).toHaveLength(43);
    const exit = await db.collection("changelog_exits").doc(email.exit).get();
    expect(exit.data()).toMatchObject({ tenantId: who.tenantId, userId: who.userId });
  });

  it("records a no as a no, and keeps the same way out through every change", async () => {
    const who = await person();
    await changelog.subscribe(who.tenantId, who.userId, true, "signup", T0);
    const code = (await stored(who))!.email.exit;
    await changelog.subscribe(who.tenantId, who.userId, false, "settings", later(1));
    expect(await changelog.subscription(who.tenantId, who.userId)).toEqual({
      on: false,
      at: later(1),
    });
    await changelog.subscribe(who.tenantId, who.userId, true, "settings", later(2));
    expect((await stored(who))!.email.exit).toBe(code);
  });

  it("does not touch what the person has read", async () => {
    const who = await person();
    await changelog.markRead(who.tenantId, who.userId);
    await changelog.subscribe(who.tenantId, who.userId, true, "settings", T0);
    expect((await stored(who))!.read).toBe("2.10.0");
  });

  it("reads something malformed as never answered", async () => {
    const who = await person();
    await tenantRef(db, who.tenantId)
      .collection("changelog_state")
      .doc(who.userId)
      .set({ email: { on: "yes" } });
    expect(await changelog.subscription(who.tenantId, who.userId)).toEqual({ on: false, at: null });
  });
});

describe("leaving by a link", () => {
  it("turns the e-mails off for the person the code names", async () => {
    const who = await person();
    await changelog.subscribe(who.tenantId, who.userId, true, "settings", T0);
    const code = (await stored(who))!.email.exit;
    await changelog.unsubscribe(code, later(5));
    expect(await changelog.subscription(who.tenantId, who.userId)).toEqual({
      on: false,
      at: later(5),
    });
    expect((await stored(who))!.email).toMatchObject({ source: "unsubscribe", exit: code });
  });

  it("can only turn them off: used again, it changes nothing", async () => {
    const who = await person();
    await changelog.subscribe(who.tenantId, who.userId, true, "settings", T0);
    const code = (await stored(who))!.email.exit;
    await changelog.unsubscribe(code, later(5));
    await changelog.unsubscribe(code, later(9));
    expect((await changelog.subscription(who.tenantId, who.userId)).at).toEqual(later(5));
  });

  it("still works on an old message after a no and a new yes", async () => {
    const who = await person();
    await changelog.subscribe(who.tenantId, who.userId, true, "settings", T0);
    const code = (await stored(who))!.email.exit;
    await changelog.subscribe(who.tenantId, who.userId, false, "settings", later(1));
    await changelog.subscribe(who.tenantId, who.userId, true, "settings", later(2));
    await changelog.unsubscribe(code, later(3));
    expect((await changelog.subscription(who.tenantId, who.userId)).on).toBe(false);
  });

  it.each([
    ["an unknown code", "x".repeat(43)],
    ["a mangled one", "not-a-code"],
    ["nothing", undefined],
  ])("ends in silence for %s", async (_case, code) => {
    await expect(changelog.unsubscribe(code)).resolves.toBeUndefined();
  });
});

describe("a report from the mail service", () => {
  it("ends the e-mails of the person whose account holds the address", async () => {
    const who = await person();
    await changelog.subscribe(who.tenantId, who.userId, true, "settings", T0);
    expect(
      await changelog.applyMailEvents([{ email: who.email, at: later(10), kind: "spam_report" }]),
    ).toEqual({ ended: 1 });
    expect(await changelog.subscription(who.tenantId, who.userId)).toEqual({
      on: false,
      at: later(10),
    });
    expect((await stored(who))!.email.source).toBe("spam_report");
  });

  it("does not undo a yes given after the event", async () => {
    const who = await person();
    await changelog.subscribe(who.tenantId, who.userId, true, "settings", later(20));
    expect(await changelog.applyMailEvents([{ email: who.email, at: later(10) }])).toEqual({
      ended: 0,
    });
    expect((await changelog.subscription(who.tenantId, who.userId)).on).toBe(true);
  });

  it("counts a person once for a batch that names them twice, and skips the rest", async () => {
    const who = await person();
    const off = await person();
    await changelog.subscribe(who.tenantId, who.userId, true, "settings", T0);
    await changelog.subscribe(off.tenantId, off.userId, false, "settings", T0);
    expect(
      await changelog.applyMailEvents([
        { email: who.email, at: later(10) },
        { email: who.email, at: later(11) },
        { email: off.email, at: later(10) },
        { email: "nobody@example.net", at: later(10) },
        { email: "not an address", at: later(10) },
      ]),
    ).toEqual({ ended: 1 });
  });
});

describe("the e-mail run", () => {
  const subscribed = async (options: Parameters<typeof person>[0] = {}) => {
    const who = await person(options);
    // Asked while 2.9.0 was the newest release.
    await changelogOf([NOTES[1]!]).subscribe(who.tenantId, who.userId, true, "settings", T0);
    return who;
  };

  it("sends the newest release once to each person who asked, across tenants", async () => {
    const one = await subscribed();
    const two = await subscribed();
    const box = mailbox();
    expect(await changelog.send(box.deliver, { now: later(60) })).toEqual({
      version: "2.10.0",
      sent: 2,
      failed: 0,
    });
    expect(box.delivered.map((d) => d.to).sort()).toEqual([one.email, two.email].sort());
    const message = box.delivered.find((d) => d.to === one.email)!;
    const code = (await stored(one))!.email.exit;
    expect(message.note).toEqual(NOTES[0]);
    expect(message.subscribedAt).toEqual(T0);
    expect(message.unsubscribeUrl).toBe(
      `https://app.example.com/changelog/unsubscribe#token=${code}`,
    );
    expect(message.oneClickUrl).toBe(`https://app.example.com/api/changelog/unsubscribe?t=${code}`);

    // A second run the same day finds nobody left.
    const again = mailbox();
    expect(await changelog.send(again.deliver)).toEqual({ version: "2.10.0", sent: 0, failed: 0 });
    expect(again.attempts()).toBe(0);
  });

  it("starts a new yes at the next release", async () => {
    const who = await person();
    await changelog.subscribe(who.tenantId, who.userId, true, "settings", T0);
    const box = mailbox();
    expect((await changelog.send(box.deliver)).sent).toBe(0);
    const next = changelogOf([{ version: "2.11.0", title: "Kanban" }, ...NOTES]);
    expect((await next.send(box.deliver)).sent).toBe(1);
    expect(box.delivered[0]!.to).toBe(who.email);
  });

  it("does not send an older release again after a rollback", async () => {
    await subscribed();
    await changelog.send(mailbox().deliver);
    const box = mailbox();
    expect((await changelogOf([NOTES[1]!]).send(box.deliver)).sent).toBe(0);
  });

  it("writes only to a confirmed address of an account that is open", async () => {
    await subscribed({ verified: false });
    await subscribed({ disabled: true });
    const ok = await subscribed();
    const box = mailbox();
    expect((await changelog.send(box.deliver)).sent).toBe(1);
    expect(box.delivered.map((d) => d.to)).toEqual([ok.email]);
  });

  it("skips a person whose account another tenant holds now", async () => {
    const moved = await subscribed();
    await auth.setCustomUserClaims(moved.userId, { tenant: "another-tenant", role: "member" });
    const box = mailbox();
    expect((await changelog.send(box.deliver)).sent).toBe(0);
  });

  it("skips whoever left by their link, or said no", async () => {
    const left = await subscribed();
    const said = await subscribed();
    await changelog.unsubscribe((await stored(left))!.email.exit);
    await changelogOf([NOTES[1]!]).subscribe(said.tenantId, said.userId, false, "settings");
    const box = mailbox();
    expect((await changelog.send(box.deliver)).sent).toBe(0);
  });

  it("counts a refused message and does not try it again, once the sender is known to work", async () => {
    const good = await subscribed();
    const bad = await subscribed();
    // Whichever comes first: one accepted message is enough for the refusal to count as the person's.
    const box = mailbox((to) => (to === good.email ? null : { status: 400 }));
    expect(await changelog.send(box.deliver)).toEqual({ version: "2.10.0", sent: 1, failed: 1 });
    expect((await stored(bad))!.email.sent).toBe("2.10.0");
    const again = mailbox();
    expect((await changelog.send(again.deliver)).sent).toBe(0);
  });

  it("gives every mark back and stops when every message is refused", async () => {
    const people = await Promise.all([subscribed(), subscribed(), subscribed(), subscribed()]);
    const box = mailbox(() => ({ status: 400 }));
    const stopped = await changelog.send(box.deliver).catch((e) => e);
    expect(stopped).toBeInstanceOf(SendStopped);
    expect(stopped.reason).toBe("sender");
    // It stopped at the third refusal, and nobody lost the version.
    expect(box.attempts()).toBe(3);
    for (const who of people) expect((await stored(who))!.email.sent).toBe("2.9.0");

    // With the sender fixed, everyone gets it.
    const fixed = mailbox();
    expect((await changelog.send(fixed.deliver)).sent).toBe(4);
  });

  it("gives the mark back and stops when the sender cannot send", async () => {
    const people = await Promise.all([subscribed(), subscribed()]);
    const box = mailbox(() => ({ status: 401 }));
    const stopped = await changelog.send(box.deliver).catch((e) => e);
    expect(stopped).toBeInstanceOf(SendStopped);
    expect(stopped.reason).toBe("sender");
    expect(stopped.cause).toEqual({ status: 401 });
    expect(box.attempts()).toBe(1);
    for (const who of people) expect((await stored(who))!.email.sent).toBe("2.9.0");
  });

  it("stops and keeps the one mark when no answer came: the message may have left", async () => {
    const people = await Promise.all([subscribed(), subscribed()]);
    const box = mailbox(() => ({ status: null }));
    const stopped = await changelog.send(box.deliver).catch((e) => e);
    expect(stopped).toBeInstanceOf(SendStopped);
    expect(stopped.reason).toBe("unknown");
    const marks = await Promise.all(people.map(async (who) => (await stored(who))!.email.sent));
    expect(marks.sort()).toEqual(["2.10.0", "2.9.0"]);
  });

  it("hands each person to one of two runs at the same moment", async () => {
    await Promise.all([subscribed(), subscribed(), subscribed()]);
    const box = mailbox();
    const [a, b] = await Promise.all([changelog.send(box.deliver), changelog.send(box.deliver)]);
    expect(a.sent + b.sent).toBe(3);
    expect(new Set(box.delivered.map((d) => d.to)).size).toBe(3);
  });

  it("follows the caller's own reading of a failure", async () => {
    await subscribed();
    const box = mailbox(() => new Error("quota"));
    const stopped = await changelog
      .send(box.deliver, { classify: () => "unknown" })
      .catch((e) => e);
    expect(stopped.reason).toBe("unknown");
  });

  it("sends nothing before the first release", async () => {
    await subscribed();
    const box = mailbox();
    expect(await changelogOf([]).send(box.deliver)).toEqual({ version: null, sent: 0, failed: 0 });
  });
});

describe("forgetting a person who left", () => {
  it("removes their state and makes their old link do nothing", async () => {
    const who = await person();
    await changelog.subscribe(who.tenantId, who.userId, true, "settings", T0);
    const code = (await stored(who))!.email.exit;
    await changelog.forget(who.tenantId, who.userId);
    expect(await stored(who)).toBeUndefined();
    expect((await db.collection("changelog_exits").doc(code).get()).exists).toBe(false);
    await expect(changelog.unsubscribe(code)).resolves.toBeUndefined();
    expect(await stored(who)).toBeUndefined();
  });
});

describe("the app's origin", () => {
  it("is refused when it is not an http(s) origin", () => {
    expect(() =>
      createChangelog({ firestore: db, auth, notes: NOTES, origin: "app.example.com" }),
    ).toThrow("http(s) origin");
  });
});
