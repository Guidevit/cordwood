// The custom claims this package writes on a Firebase Auth account. Only the server writes them.
import type { Auth, UserRecord } from "firebase-admin/auth";
import type { RoleMap, RoleOf, Roles } from "./roles.js";

/** The tenant the account belongs to. */
export const TENANT_CLAIM = "tenant";
/** The account's role in that tenant. */
export const ROLE_CLAIM = "role";
/** Left by a removal: the tenant that shut the account, which lets that tenant's next invite open it again. */
export const REMOVED_FROM_CLAIM = "removedFrom";

/** What a set of claims grants: a tenant and a role in it. Both null for an account no tenant has admitted. */
export type Grant<R extends RoleMap> = {
  tenantId: string | null;
  role: RoleOf<R> | null;
};

export function grantOf<R extends RoleMap>(
  claims: Record<string, unknown> | undefined,
  roles: Roles<R>,
): Grant<R> {
  const tenant = claims?.[TENANT_CLAIM];
  const role = claims?.[ROLE_CLAIM];
  return {
    tenantId: typeof tenant === "string" && tenant ? tenant : null,
    role: roles.isRole(role) ? role : null,
  };
}

export function sameGrant<R extends RoleMap>(a: Grant<R>, b: Grant<R>): boolean {
  return a.tenantId === b.tenantId && a.role === b.role;
}

function orNullWhenMissing(error: { code?: string }): null {
  if (error.code === "auth/user-not-found") return null;
  throw error;
}

export function accountByUid(auth: Auth, uid: string): Promise<UserRecord | null> {
  return auth.getUser(uid).catch(orNullWhenMissing);
}

export function accountByEmail(auth: Auth, email: string): Promise<UserRecord | null> {
  return auth.getUserByEmail(email).catch(orNullWhenMissing);
}
