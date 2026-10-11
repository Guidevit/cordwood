// How a tenant lists its members, admits one, changes one's role and takes one's access away.
//
// Only the server manages members. Admitting creates the Auth account with the tenant and the role as
// custom claims and hands the app a password-reset link to deliver, so there is no initial-password
// screen: completing that link also marks the e-mail verified, which the session exchange requires.
// The roster is kept at tenants/{tenantId}/members/{uid}, so listing never scans another tenant's accounts.
import { randomBytes } from "node:crypto";
import type { Auth, UserRecord } from "firebase-admin/auth";
import {
  FieldValue,
  type DocumentReference,
  type Firestore,
  type Timestamp,
} from "firebase-admin/firestore";
import { tenantRef } from "@cordwood/firebase";
import {
  REMOVED_FROM_CLAIM,
  ROLE_CLAIM,
  TENANT_CLAIM,
  accountByEmail,
  accountByUid,
} from "./claims.js";
import type { PermissionOf, RoleMap, RoleOf, Roles } from "./roles.js";
import { MEMBERS, followRow, takeTurn } from "./turn.js";

export type Member<R extends RoleMap> = {
  uid: string;
  email: string;
  name: string | null;
  role: RoleOf<R>;
  invitedAt: Date | null;
};

/** Whom to admit. */
export type Admission<R extends RoleMap> = {
  email: string;
  role: RoleOf<R>;
  name?: string;
};

/** What the app delivers to the person admitted, by e-mail or any way it has. */
export type Invite<R extends RoleMap> = {
  email: string;
  name: string | null;
  role: RoleOf<R>;
  /** A one-time link where the person sets their password. Completing it proves the address. */
  link: string;
};

/**
 * How the admitted person gets in.
 *
 * With `deliver`: a password-reset link that returns to `continueUrl`, handed to `deliver`. When
 * `deliver` throws, the admission is undone and the error is rethrown, since nobody holds the link.
 *
 * With `password`: the password the person typed, for a sign-up whose own link already proved the
 * address. Nothing is delivered, and the account is marked verified. Never pass a password for an
 * address nobody proved.
 */
export type Entry<R extends RoleMap> =
  | { continueUrl: string; deliver: (invite: Invite<R>) => Promise<void> }
  | { password: string };

/**
 * `member`: the address is already this tenant's. `other_tenant`: another tenant holds it, and moving
 * someone's access between tenants is a person's decision. `disabled`: the account was shut by someone
 * other than this tenant's removal, and an invite must not reopen it.
 */
export type AdmitRefusal = "member" | "other_tenant" | "disabled";

export type Admitted<R extends RoleMap> =
  | { ok: true; member: Member<R>; link: string | null }
  | { ok: false; reason: AdmitRefusal };

/** `self`: nobody acts on their own membership. `absent`: not a member here. `forbidden`: who acts may not, or no longer. */
export type ActRefusal = "self" | "absent" | "forbidden";

export type RoleChanged<R extends RoleMap> =
  | { ok: true; role: RoleOf<R>; changed: boolean }
  | { ok: false; reason: ActRefusal };

export type Removed = { ok: true } | { ok: false; reason: ActRefusal };

export type MembersConfig<R extends RoleMap> = {
  auth: Auth;
  firestore: Firestore;
  roles: Roles<R>;
  /** The permission that lets a member change roles and remove members. */
  managePermission: PermissionOf<R>;
  /** Receives one line when an undo could not finish: an error code, never an address. */
  log?: (line: string) => void;
};

export type Members<R extends RoleMap> = {
  /**
   * Admits `admission.email` to the tenant: a new account, an existing one no tenant holds, or one this
   * tenant removed. `invitedBy` is kept on the roster row: a uid, or a label for an operator's command.
   */
  admit(
    tenantId: string,
    admission: Admission<R>,
    entry: Entry<R>,
    invitedBy: string,
  ): Promise<Admitted<R>>;
  /** The tenant's members, oldest admission first. */
  list(tenantId: string): Promise<Member<R>[]>;
  /** Gives `uid` a new role and ends their open sessions. `actorUid` must hold the manage permission. */
  changeRole(
    tenantId: string,
    uid: string,
    role: RoleOf<R>,
    actorUid: string,
  ): Promise<RoleChanged<R>>;
  /** Takes `uid`'s access to the tenant away at once. `actorUid` must hold the manage permission. */
  remove(tenantId: string, uid: string, actorUid: string): Promise<Removed>;
};

type Row = { email?: string; role?: string; invitedAt?: Timestamp };

/** What an admission has done so far, so a failure takes back exactly that. */
type Done = {
  account: UserRecord;
  created: boolean;
  row: DocumentReference | null;
  adjusted: boolean;
};

// getUsers takes at most 100 identifiers per call.
const PER_LOOKUP = 100;

/** Whether an account has a password: a `password` provider. */
const hasPassword = (account: UserRecord) =>
  account.providerData.some((p) => p.providerId === "password");

function refusalOf(existing: UserRecord | null, tenantId: string): AdmitRefusal | null {
  const owner = existing?.customClaims?.[TENANT_CLAIM];
  if (owner) return owner === tenantId ? "member" : "other_tenant";
  if (existing?.disabled && existing.customClaims?.[REMOVED_FROM_CLAIM] !== tenantId)
    return "disabled";
  return null;
}

export function createMembers<R extends RoleMap>(config: MembersConfig<R>): Members<R> {
  const { auth, firestore, roles, managePermission } = config;
  const log = config.log ?? (() => {});
  const mayManage = (role: unknown) =>
    roles.isRole(role) && roles.can(role, managePermission);

  /**
   * The account as the tenant admits it: under the name the admission gave (none given leaves its own),
   * enabled again if a removal disabled it, and with the sign-up's password, verified, when one was
   * typed. Answers whether it changed, so a later failure puts it back.
   */
  async function adjust(
    account: UserRecord,
    name: string | undefined,
    password: string | null,
  ): Promise<boolean> {
    const rename = name !== undefined && name !== account.displayName;
    if (!account.disabled && !rename && !password) return false;
    await auth.updateUser(account.uid, {
      disabled: false,
      ...(rename ? { displayName: name } : {}),
      ...(password ? { password, emailVerified: true } : {}),
    });
    return true;
  }

  /**
   * An existing account about to gain a tenant's access, left with no password and no session the
   * server did not hand out in this admission. Anyone with the public web key can register an address
   * before its owner arrives, so a password already on the account may be a stranger's: it is replaced
   * by one nobody knows unless this admission just set the owner's, and every token minted before now
   * is revoked.
   */
  async function dropOutsideAccess(account: UserRecord, passwordJustSet: boolean) {
    if (!passwordJustSet && hasPassword(account))
      await auth.updateUser(account.uid, {
        password: randomBytes(32).toString("base64url"),
      });
    await auth.revokeRefreshTokens(account.uid);
  }

  /**
   * Takes back what a failed admission did. Every step is tried even when another fails. The caller
   * rethrows the original error, so an undo that fails never hides why the admission failed.
   */
  async function undo({ account, created, row, adjusted }: Done): Promise<void> {
    const onAccount = created
      ? [auth.deleteUser(account.uid)]
      : [
          auth.setCustomUserClaims(account.uid, account.customClaims ?? null),
          ...(adjusted
            ? [
                auth.updateUser(account.uid, {
                  disabled: account.disabled,
                  displayName: account.displayName ?? null,
                }),
              ]
            : []),
        ];
    const results = await Promise.allSettled([...(row ? [row.delete()] : []), ...onAccount]);
    // The error's code only: Firebase's messages can carry the address.
    for (const r of results)
      if (r.status === "rejected")
        log(
          `[auth] admission not fully undone: ${(r.reason as { code?: string })?.code ?? "no code"}`,
        );
  }

  async function admit(
    tenantId: string,
    admission: Admission<R>,
    entry: Entry<R>,
    invitedBy: string,
  ): Promise<Admitted<R>> {
    const tenant = tenantRef(firestore, tenantId);
    if (!roles.isRole(admission.role)) throw new Error("unknown role");
    const existing = await accountByEmail(auth, admission.email);
    const refusal = refusalOf(existing, tenantId);
    if (refusal) return { ok: false, reason: refusal };
    const password = "password" in entry ? entry.password : null;
    const account =
      existing ??
      (await auth.createUser({
        email: admission.email,
        displayName: admission.name,
        ...(password ? { password, emailVerified: true } : { emailVerified: false }),
      }));
    const done: Done = { account, created: !existing, row: null, adjusted: false };
    const name = admission.name ?? account.displayName ?? null;
    let link: string | null = null;
    // In order: the roster row, then the access (the account, then the claims), and only then the
    // delivery, since a sent message cannot be unsent.
    try {
      if ("deliver" in entry)
        link = await auth.generatePasswordResetLink(admission.email, {
          url: entry.continueUrl,
        });
      const row = tenant.collection(MEMBERS).doc(account.uid);
      await row.set({
        email: admission.email,
        role: admission.role,
        invitedBy,
        invitedAt: FieldValue.serverTimestamp(),
      });
      done.row = row;
      done.adjusted = await adjust(account, admission.name, existing ? password : null);
      if (existing) await dropOutsideAccess(existing, password !== null);
      const { [REMOVED_FROM_CLAIM]: _removed, ...rest } = account.customClaims ?? {};
      await auth.setCustomUserClaims(account.uid, {
        ...rest,
        [TENANT_CLAIM]: tenantId,
        [ROLE_CLAIM]: admission.role,
      });
      if ("deliver" in entry && link)
        await entry.deliver({ email: admission.email, name, role: admission.role, link });
    } catch (error) {
      await undo(done);
      throw error;
    }
    return {
      ok: true,
      member: {
        uid: account.uid,
        email: admission.email,
        name,
        role: admission.role,
        invitedAt: null,
      },
      link,
    };
  }

  async function list(tenantId: string): Promise<Member<R>[]> {
    const roster = await tenantRef(firestore, tenantId).collection(MEMBERS).get();
    if (roster.empty) return [];
    const batches = Array.from(
      { length: Math.ceil(roster.size / PER_LOOKUP) },
      (_, i) =>
        roster.docs
          .slice(i * PER_LOOKUP, (i + 1) * PER_LOOKUP)
          .map((d) => ({ uid: d.id })),
    );
    const found = await Promise.all(batches.map((ids) => auth.getUsers(ids)));
    const byUid = new Map(found.flatMap((f) => f.users).map((u) => [u.uid, u]));
    const when = (row: Row) => row.invitedAt?.toMillis() ?? 0;
    return roster.docs
      .map((d) => ({ uid: d.id, row: d.data() as Row }))
      .sort((a, b) => when(a.row) - when(b.row))
      .flatMap(({ uid, row }) => {
        const account = byUid.get(uid);
        // An account of this roster that another tenant holds now is not this tenant's member.
        if (account && account.customClaims?.[TENANT_CLAIM] !== tenantId) return [];
        // The claim is the role the server enforces. The row only remembers who was admitted.
        const role = account?.customClaims?.[ROLE_CLAIM] ?? row.role;
        if (!roles.isRole(role)) return [];
        return [
          {
            uid,
            email: account?.email ?? row.email ?? "",
            name: account?.displayName ?? null,
            role,
            invitedAt: row.invitedAt?.toDate() ?? null,
          },
        ];
      });
  }

  // The row takes the role first, in the transaction that orders two managers. Then the claims, so
  // every open session of the member fails its next request, made to follow the row. Then the refresh
  // tokens are revoked. A failure after the row and before the claims leaves the row ahead: the list
  // shows the new role and the member keeps the old one until the change is asked again.
  async function changeRole(
    tenantId: string,
    uid: string,
    role: RoleOf<R>,
    actorUid: string,
  ): Promise<RoleChanged<R>> {
    const tenant = tenantRef(firestore, tenantId);
    if (!roles.isRole(role)) throw new Error("unknown role");
    if (uid === actorUid) return { ok: false, reason: "self" };
    const account = await accountByUid(auth, uid);
    if (!account || account.disabled || account.customClaims?.[TENANT_CLAIM] !== tenantId)
      return { ok: false, reason: "absent" };
    const turn = await takeTurn(tenant, actorUid, uid, { role }, mayManage);
    if (turn === "actor") return { ok: false, reason: "forbidden" };
    if (turn === "absent") return { ok: false, reason: "absent" };
    const changed = account.customClaims[ROLE_CLAIM] !== role;
    if (changed)
      await auth.setCustomUserClaims(uid, { ...account.customClaims, [ROLE_CLAIM]: role });
    const settled = await followRow(auth, tenant, uid, role);
    if (!settled || !roles.isRole(settled)) return { ok: false, reason: "absent" };
    if (changed || settled !== role) await auth.revokeRefreshTokens(uid);
    return { ok: true, role: settled, changed };
  }

  // The tenant's claims go first, so every open session fails its next request. Then the account is
  // disabled and its refresh tokens revoked, and the roster row goes. Nobody removes themselves, which
  // is what keeps a tenant from losing its last manager. Each step is safe to repeat.
  //
  // The claims keep one marker, `removedFrom`, which lets this tenant's next invite enable the account
  // again. It is written only when this removal is what shuts the account: one already disabled, with
  // no marker of this tenant, was shut by someone else and stays shut.
  async function remove(tenantId: string, uid: string, actorUid: string): Promise<Removed> {
    const tenant = tenantRef(firestore, tenantId);
    if (uid === actorUid) return { ok: false, reason: "self" };
    const row = tenant.collection(MEMBERS).doc(uid);
    const [read, account] = await Promise.all([row.get(), accountByUid(auth, uid)]);
    const owner = account?.customClaims?.[TENANT_CLAIM];
    if (!read.exists || (owner !== undefined && owner !== tenantId))
      return { ok: false, reason: "absent" };
    const turn = await takeTurn(tenant, actorUid, uid, { removing: true }, mayManage);
    if (turn === "actor") return { ok: false, reason: "forbidden" };
    if (turn === "absent") return { ok: false, reason: "absent" };
    if (account) {
      const {
        [TENANT_CLAIM]: _t,
        [ROLE_CLAIM]: _r,
        [REMOVED_FROM_CLAIM]: marker,
        ...rest
      } = account.customClaims ?? {};
      const reopenable = !account.disabled || marker === tenantId;
      await auth.setCustomUserClaims(
        uid,
        reopenable ? { ...rest, [REMOVED_FROM_CLAIM]: tenantId } : rest,
      );
      await auth.updateUser(uid, { disabled: true });
      await auth.revokeRefreshTokens(uid);
    }
    // The row and what hangs under it: Firestore does not cascade, and an app may keep a member's own
    // documents under their row.
    await firestore.recursiveDelete(row);
    return { ok: true };
  }

  return { admit, list, changeRole, remove };
}
