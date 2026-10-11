// Runs against the Auth and Firestore emulators: `pnpm test` starts both.
import { randomUUID } from "node:crypto";
import { auth as adminAuth, firestore as adminFirestore, tenantRef } from "@cordwood/firebase";
import { beforeAll, describe, expect, it } from "vitest";
import { createAuth, defineRoles, type Invite, type RoleOf, type Roles } from "./index.js";

const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST;
if (!AUTH_HOST || !process.env.FIRESTORE_EMULATOR_HOST)
  throw new Error("the emulators are not running: use `pnpm test`");

const roles = defineRoles({
  admin: ["read", "write", "members.manage"],
  editor: ["read", "write"],
  viewer: ["read"],
});
type Map = typeof roles extends Roles<infer M> ? M : never;
type R = RoleOf<Map>;

const lines: string[] = [];
const auth = adminAuth();
const db = adminFirestore();
const cordwood = createAuth({
  auth,
  firestore: db,
  roles,
  managePermission: "members.manage",
  log: (line) => lines.push(line),
});
const { sessions, access, members } = cordwood;

const PASSWORD = "correct horse battery staple";
const id = () => randomUUID().replaceAll("-", "").slice(0, 20);
const address = () => `${id()}@example.com`;

/** What the browser does: signs in with a password and gets an ID token. */
async function signIn(email: string, password = PASSWORD): Promise<string> {
  const response = await fetch(
    `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  const body = (await response.json()) as { idToken?: string; error?: { message: string } };
  if (!body.idToken) throw new Error(`sign-in failed: ${body.error?.message}`);
  return body.idToken;
}

/** A tenant with its first member, admitted the way a sign-up admits: with the password they typed. */
async function tenantWith(role: R = "admin") {
  const tenantId = id();
  const email = address();
  const admitted = await members.admit(tenantId, { email, role }, { password: PASSWORD }, "sign-up");
  if (!admitted.ok) throw new Error(admitted.reason);
  return { tenantId, email, uid: admitted.member.uid };
}

async function addMember(tenantId: string, role: R, by: string) {
  const email = address();
  const admitted = await members.admit(tenantId, { email, role }, { password: PASSWORD }, by);
  if (!admitted.ok) throw new Error(admitted.reason);
  return { email, uid: admitted.member.uid };
}

async function cookieOf(email: string): Promise<string> {
  const exchanged = await sessions.exchange(await signIn(email));
  if (!exchanged.ok) throw new Error(exchanged.reason);
  return exchanged.cookie;
}

const request = (method: string, cookie?: string) =>
  new Request("https://app.example.com/api/things", {
    method,
    headers: {
      "sec-fetch-site": "same-origin",
      ...(cookie ? { cookie: `${cordwood.cookieName}=${cookie}` } : {}),
    },
  });

beforeAll(() => {
  expect(cordwood.cookieName).toBe("__session");
});

describe("a session", () => {
  it("is exchanged for a fresh token of a verified e-mail, and read back", async () => {
    const { tenantId, email, uid } = await tenantWith("admin");
    const exchanged = await sessions.exchange(await signIn(email));
    expect(exchanged).toMatchObject({ ok: true, session: { uid, email, tenantId, role: "admin" } });
    if (!exchanged.ok) return;
    expect(await sessions.read(exchanged.cookie)).toEqual({ uid, email, tenantId, role: "admin" });
  });

  it("has no tenant and no role for an account no tenant admitted", async () => {
    const email = address();
    const { uid } = await auth.createUser({ email, password: PASSWORD, emailVerified: true });
    expect(await sessions.read(await cookieOf(email))).toEqual({
      uid,
      email,
      tenantId: null,
      role: null,
    });
  });

  it("is refused for an e-mail nobody verified", async () => {
    const email = address();
    await auth.createUser({ email, password: PASSWORD, emailVerified: false });
    expect(await sessions.exchange(await signIn(email))).toEqual({
      ok: false,
      reason: "email_unverified",
    });
  });

  it("is refused for a sign-in older than five minutes", async () => {
    const { email } = await tenantWith();
    const later = Date.now() / 1000 + 301;
    expect(await sessions.exchange(await signIn(email), later)).toEqual({
      ok: false,
      reason: "stale_sign_in",
    });
  });

  it.each([
    ["text that is no token", "not-a-token"],
    ["a payload that is not JSON", "aaaa.bm90IGpzb24.cccc"],
    ["a payload of null", `aaaa.${Buffer.from("null").toString("base64url")}.cccc`],
    ["an empty string", ""],
  ])("answers `token` for %s, and reads no session from it", async (_case, value) => {
    expect(await sessions.exchange(value)).toEqual({ ok: false, reason: "token" });
    expect(await sessions.read(value)).toBeNull();
    expect(await sessions.end(value)).toBe(false);
  });

  it("is null without a cookie", async () => {
    expect(await sessions.read(undefined)).toBeNull();
  });

  it("ends on every device at sign-out", async () => {
    const { email } = await tenantWith();
    const here = await cookieOf(email);
    const there = await cookieOf(email);
    // A revocation counts whole seconds: a cookie minted in that same second would survive it.
    await new Promise((done) => setTimeout(done, 1100));
    expect(await sessions.end(here)).toBe(true);
    expect(await sessions.read(here)).toBeNull();
    expect(await sessions.read(there)).toBeNull();
  });

  it("stops reading once the account's claims differ from the cookie's", async () => {
    const { email, uid, tenantId } = await tenantWith("admin");
    const cookie = await cookieOf(email);
    await auth.setCustomUserClaims(uid, { tenant: tenantId, role: "viewer" });
    expect(await sessions.read(cookie)).toBeNull();
  });

  it("stops reading once the account is disabled", async () => {
    const { email, uid } = await tenantWith();
    const cookie = await cookieOf(email);
    await auth.updateUser(uid, { disabled: true });
    expect(await sessions.read(cookie)).toBeNull();
  });

  it("sets its cookie HttpOnly, Secure and for five days", () => {
    expect(cordwood.cookieOptions).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 432000,
    });
  });
});

describe("a route's access", () => {
  it("is the tenant, the person and the role of the verified cookie", async () => {
    const { tenantId, email, uid } = await tenantWith("editor");
    expect(await access.require(request("POST", await cookieOf(email)), "write")).toEqual({
      ok: true,
      tenantId,
      uid,
      email,
      role: "editor",
    });
  });

  it("is 401 without a session", async () => {
    expect(await access.require(request("GET"), "read")).toEqual({
      ok: false,
      status: 401,
      reason: "no_session",
    });
  });

  it("is 403 for a user no tenant admitted", async () => {
    const email = address();
    await auth.createUser({ email, password: PASSWORD, emailVerified: true });
    expect(await access.require(request("GET", await cookieOf(email)), "read")).toEqual({
      ok: false,
      status: 403,
      reason: "no_tenant",
    });
  });

  it("is 403 for a role without the permission", async () => {
    const { email } = await tenantWith("viewer");
    expect(await access.require(request("POST", await cookieOf(email)), "write")).toEqual({
      ok: false,
      status: 403,
      reason: "forbidden",
    });
  });

  it("is 403 for a write from another site, even with a good cookie", async () => {
    const { email } = await tenantWith("admin");
    const forged = new Request("https://app.example.com/api/things", {
      method: "POST",
      headers: {
        "sec-fetch-site": "cross-site",
        cookie: `__session=${await cookieOf(email)}`,
      },
    });
    expect(await access.require(forged, "write")).toEqual({
      ok: false,
      status: 403,
      reason: "cross_site",
    });
  });
});

describe("admitting a member", () => {
  const CONTINUE = "https://app.example.com/welcome";

  it("creates the account, the roster row and the claims, and delivers a link", async () => {
    const { tenantId, uid: adminUid } = await tenantWith();
    const email = address();
    const delivered: Invite<Map>[] = [];
    const admitted = await members.admit(
      tenantId,
      { email, role: "editor", name: "Ana Lima" },
      { continueUrl: CONTINUE, deliver: async (invite) => void delivered.push(invite) },
      adminUid,
    );
    expect(admitted).toMatchObject({
      ok: true,
      member: { email, name: "Ana Lima", role: "editor" },
    });
    if (!admitted.ok) return;
    expect(delivered).toEqual([{ email, name: "Ana Lima", role: "editor", link: admitted.link }]);
    expect(admitted.link).toContain("oobCode=");
    expect(admitted.link).toContain(encodeURIComponent(CONTINUE));

    const account = await auth.getUser(admitted.member.uid);
    expect(account.customClaims).toEqual({ tenant: tenantId, role: "editor" });
    expect(account.emailVerified).toBe(false);
    const row = await tenantRef(db, tenantId).collection("members").doc(account.uid).get();
    expect(row.data()).toMatchObject({ email, role: "editor", invitedBy: adminUid });
  });

  it("undoes everything when the delivery fails, and rethrows", async () => {
    const { tenantId, uid } = await tenantWith();
    const email = address();
    const failure = new Error("mail is down");
    await expect(
      members.admit(
        tenantId,
        { email, role: "viewer" },
        { continueUrl: CONTINUE, deliver: () => Promise.reject(failure) },
        uid,
      ),
    ).rejects.toBe(failure);
    await expect(auth.getUserByEmail(email)).rejects.toMatchObject({
      code: "auth/user-not-found",
    });
    const roster = await tenantRef(db, tenantId).collection("members").get();
    expect(roster.docs.map((d) => d.id)).toEqual([uid]);
  });

  it("puts an existing account back as it was when the delivery fails", async () => {
    const { tenantId, uid } = await tenantWith();
    const email = address();
    const before = await auth.createUser({ email, displayName: "Before", emailVerified: true });
    await expect(
      members.admit(
        tenantId,
        { email, role: "viewer", name: "After" },
        { continueUrl: CONTINUE, deliver: () => Promise.reject(new Error("down")) },
        uid,
      ),
    ).rejects.toThrow("down");
    const after = await auth.getUser(before.uid);
    expect(after.displayName).toBe("Before");
    expect(after.customClaims ?? {}).toEqual({});
    expect((await tenantRef(db, tenantId).collection("members").doc(before.uid).get()).exists).toBe(
      false,
    );
  });

  it("takes away a password somebody else may have set on the address first", async () => {
    const { tenantId, uid } = await tenantWith();
    const email = address();
    await auth.createUser({ email, password: "the squatter's password", emailVerified: false });
    const admitted = await members.admit(
      tenantId,
      { email, role: "viewer" },
      { continueUrl: CONTINUE, deliver: async () => {} },
      uid,
    );
    expect(admitted.ok).toBe(true);
    await expect(signIn(email, "the squatter's password")).rejects.toThrow("INVALID");
  });

  it("refuses an address this tenant already has", async () => {
    const { tenantId, email, uid } = await tenantWith();
    expect(
      await members.admit(tenantId, { email, role: "viewer" }, { password: PASSWORD }, uid),
    ).toEqual({ ok: false, reason: "member" });
  });

  it("refuses an address another tenant holds, and leaves it there", async () => {
    const theirs = await tenantWith("editor");
    const ours = await tenantWith();
    expect(
      await members.admit(
        ours.tenantId,
        { email: theirs.email, role: "admin" },
        { password: PASSWORD },
        ours.uid,
      ),
    ).toEqual({ ok: false, reason: "other_tenant" });
    expect((await auth.getUser(theirs.uid)).customClaims).toEqual({
      tenant: theirs.tenantId,
      role: "editor",
    });
  });

  it("refuses an account somebody else disabled", async () => {
    const { tenantId, uid } = await tenantWith();
    const email = address();
    await auth.createUser({ email, disabled: true });
    expect(
      await members.admit(tenantId, { email, role: "viewer" }, { password: PASSWORD }, uid),
    ).toEqual({ ok: false, reason: "disabled" });
  });

  it("throws on a role the app never defined", async () => {
    const { tenantId, uid } = await tenantWith();
    await expect(
      members.admit(
        tenantId,
        { email: address(), role: "owner" as R },
        { password: PASSWORD },
        uid,
      ),
    ).rejects.toThrow("unknown role");
  });

  it("throws on a tenant id that is a path", async () => {
    await expect(
      members.admit("a/b/c", { email: address(), role: "admin" }, { password: PASSWORD }, "x"),
    ).rejects.toThrow("invalid tenant id");
  });
});

describe("a tenant's members", () => {
  it("are listed oldest first, with the role the claims hold", async () => {
    const { tenantId, email, uid } = await tenantWith("admin");
    const second = await addMember(tenantId, "editor", uid);
    const third = await addMember(tenantId, "viewer", uid);
    const listed = await members.list(tenantId);
    expect(listed.map((m) => [m.email, m.role])).toEqual([
      [email, "admin"],
      [second.email, "editor"],
      [third.email, "viewer"],
    ]);
    expect(listed[0]!.invitedAt).toBeInstanceOf(Date);
  });

  it("never include another tenant's", async () => {
    const ours = await tenantWith();
    const theirs = await tenantWith();
    expect((await members.list(ours.tenantId)).map((m) => m.uid)).toEqual([ours.uid]);
    expect((await members.list(theirs.tenantId)).map((m) => m.uid)).toEqual([theirs.uid]);
  });

  it("are none for a tenant nobody joined", async () => {
    expect(await members.list(id())).toEqual([]);
  });
});

describe("changing a member's role", () => {
  it("writes the row and the claims, and ends the member's open session", async () => {
    const { tenantId, uid: admin } = await tenantWith("admin");
    const member = await addMember(tenantId, "viewer", admin);
    const cookie = await cookieOf(member.email);
    expect(await members.changeRole(tenantId, member.uid, "editor", admin)).toEqual({
      ok: true,
      role: "editor",
      changed: true,
    });
    expect((await auth.getUser(member.uid)).customClaims).toEqual({
      tenant: tenantId,
      role: "editor",
    });
    expect(await sessions.read(cookie)).toBeNull();
    expect(await sessions.read(await cookieOf(member.email))).toMatchObject({ role: "editor" });
  });

  it("changes nothing when the role is the same", async () => {
    const { tenantId, uid: admin } = await tenantWith("admin");
    const member = await addMember(tenantId, "viewer", admin);
    const cookie = await cookieOf(member.email);
    expect(await members.changeRole(tenantId, member.uid, "viewer", admin)).toEqual({
      ok: true,
      role: "viewer",
      changed: false,
    });
    expect(await sessions.read(cookie)).not.toBeNull();
  });

  it("is refused on oneself", async () => {
    const { tenantId, uid } = await tenantWith("admin");
    expect(await members.changeRole(tenantId, uid, "viewer", uid)).toEqual({
      ok: false,
      reason: "self",
    });
  });

  it("is refused to a member without the manage permission", async () => {
    const { tenantId, uid: admin } = await tenantWith("admin");
    const editor = await addMember(tenantId, "editor", admin);
    const viewer = await addMember(tenantId, "viewer", admin);
    expect(await members.changeRole(tenantId, viewer.uid, "admin", editor.uid)).toEqual({
      ok: false,
      reason: "forbidden",
    });
    expect((await auth.getUser(viewer.uid)).customClaims).toMatchObject({ role: "viewer" });
  });

  it("answers absent for another tenant's member", async () => {
    const ours = await tenantWith("admin");
    const theirs = await tenantWith("admin");
    expect(await members.changeRole(ours.tenantId, theirs.uid, "viewer", ours.uid)).toEqual({
      ok: false,
      reason: "absent",
    });
    expect((await auth.getUser(theirs.uid)).customClaims).toMatchObject({ role: "admin" });
  });

  it("leaves one admin when two demote each other at the same moment", async () => {
    const { tenantId, uid: first } = await tenantWith("admin");
    const second = await addMember(tenantId, "admin", first);
    const results = await Promise.all([
      members.changeRole(tenantId, second.uid, "viewer", first),
      members.changeRole(tenantId, first, "viewer", second.uid),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: "forbidden" }]);
    const listed = await members.list(tenantId);
    expect(listed.map((m) => m.role).sort()).toEqual(["admin", "viewer"]);
  });
});

describe("removing a member", () => {
  it("ends their session, disables the account and deletes the row", async () => {
    const { tenantId, uid: admin } = await tenantWith("admin");
    const member = await addMember(tenantId, "editor", admin);
    const cookie = await cookieOf(member.email);
    expect(await members.remove(tenantId, member.uid, admin)).toEqual({ ok: true });
    expect(await sessions.read(cookie)).toBeNull();
    const account = await auth.getUser(member.uid);
    expect(account.disabled).toBe(true);
    expect(account.customClaims).toEqual({ removedFrom: tenantId });
    expect((await members.list(tenantId)).map((m) => m.uid)).toEqual([admin]);
    await expect(signIn(member.email)).rejects.toThrow("USER_DISABLED");
  });

  it("deletes what the app kept under the member's row", async () => {
    const { tenantId, uid: admin } = await tenantWith("admin");
    const member = await addMember(tenantId, "editor", admin);
    const row = tenantRef(db, tenantId).collection("members").doc(member.uid);
    await row.collection("savedFilters").doc("one").set({ name: "mine" });
    await members.remove(tenantId, member.uid, admin);
    expect((await row.collection("savedFilters").get()).empty).toBe(true);
  });

  it("lets the same tenant admit the person again, with a new link", async () => {
    const { tenantId, uid: admin } = await tenantWith("admin");
    const member = await addMember(tenantId, "editor", admin);
    await members.remove(tenantId, member.uid, admin);
    const again = await members.admit(
      tenantId,
      { email: member.email, role: "viewer" },
      { continueUrl: "https://app.example.com/welcome", deliver: async () => {} },
      admin,
    );
    expect(again).toMatchObject({ ok: true, member: { uid: member.uid, role: "viewer" } });
    const account = await auth.getUser(member.uid);
    expect(account.disabled).toBe(false);
    expect(account.customClaims).toEqual({ tenant: tenantId, role: "viewer" });
    // The old password went with the readmission: the link is the only way back in.
    await expect(signIn(member.email)).rejects.toThrow("INVALID");
  });

  it("does not let another tenant reopen the removed account", async () => {
    const ours = await tenantWith("admin");
    const member = await addMember(ours.tenantId, "editor", ours.uid);
    await members.remove(ours.tenantId, member.uid, ours.uid);
    const theirs = await tenantWith("admin");
    expect(
      await members.admit(
        theirs.tenantId,
        { email: member.email, role: "viewer" },
        { password: PASSWORD },
        theirs.uid,
      ),
    ).toEqual({ ok: false, reason: "disabled" });
  });

  it("is refused on oneself, so a tenant keeps a manager", async () => {
    const { tenantId, uid } = await tenantWith("admin");
    expect(await members.remove(tenantId, uid, uid)).toEqual({ ok: false, reason: "self" });
  });

  it("is refused to a member without the manage permission", async () => {
    const { tenantId, uid: admin } = await tenantWith("admin");
    const editor = await addMember(tenantId, "editor", admin);
    expect(await members.remove(tenantId, admin, editor.uid)).toEqual({
      ok: false,
      reason: "forbidden",
    });
    expect((await auth.getUser(admin)).disabled).toBe(false);
  });

  it("answers absent for another tenant's member, and leaves them be", async () => {
    const ours = await tenantWith("admin");
    const theirs = await tenantWith("admin");
    expect(await members.remove(ours.tenantId, theirs.uid, ours.uid)).toEqual({
      ok: false,
      reason: "absent",
    });
    expect((await auth.getUser(theirs.uid)).disabled).toBe(false);
  });

  it("leaves one admin when two remove each other at the same moment", async () => {
    const { tenantId, uid: first } = await tenantWith("admin");
    const second = await addMember(tenantId, "admin", first);
    const results = await Promise.all([
      members.remove(tenantId, second.uid, first),
      members.remove(tenantId, first, second.uid),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: "forbidden" }]);
    expect(await members.list(tenantId)).toHaveLength(1);
  });
});

describe("the log", () => {
  it("stayed empty: no undo failed in this suite", () => {
    expect(lines).toEqual([]);
  });
});
