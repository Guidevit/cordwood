import type { Auth } from "firebase-admin/auth";
import type { Firestore } from "firebase-admin/firestore";
import { createAccess, type AccessGate } from "./access.js";
import { createMembers, type Members } from "./members.js";
import type { PermissionOf, RoleMap, Roles } from "./roles.js";
import {
  DEFAULT_COOKIE_NAME,
  createSessions,
  type Sessions,
} from "./sessions.js";

export type AuthConfig<R extends RoleMap> = {
  /** The app's firebase-admin Auth and Firestore. `@cordwood/firebase` gives both. */
  auth: Auth;
  firestore: Firestore;
  roles: Roles<R>;
  /** The permission that lets a member change roles and remove members. */
  managePermission: PermissionOf<R>;
  /** Default `__session`, the one cookie Firebase Hosting forwards to a backend. */
  cookieName?: string;
  /** How long a session lasts. Default five days. */
  maxAgeMs?: number;
  /** A sign-in older than this is not exchanged for a session. Default 300. */
  recentSignInSeconds?: number;
  /** Receives one line when an undo could not finish: an error code, never an address. */
  log?: (line: string) => void;
};

/** The attributes the session cookie is set with. `maxAge` is in seconds. */
export type CookieOptions = {
  httpOnly: true;
  secure: true;
  sameSite: "lax";
  path: "/";
  maxAge: number;
};

export type CordwoodAuth<R extends RoleMap> = {
  cookieName: string;
  cookieOptions: CookieOptions;
  sessions: Sessions<R>;
  access: AccessGate<R>;
  members: Members<R>;
};

export function createAuth<R extends RoleMap>(config: AuthConfig<R>): CordwoodAuth<R> {
  const cookieName = config.cookieName ?? DEFAULT_COOKIE_NAME;
  const sessions = createSessions(config);
  return {
    cookieName,
    cookieOptions: {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: Math.floor(sessions.maxAgeMs / 1000),
    },
    sessions,
    access: createAccess({ sessions, roles: config.roles, cookieName }),
    members: createMembers(config),
  };
}

export { defineRoles, type PermissionOf, type RoleMap, type RoleOf, type Roles } from "./roles.js";
export {
  REMOVED_FROM_CLAIM,
  ROLE_CLAIM,
  TENANT_CLAIM,
  type Grant,
} from "./claims.js";
export {
  DEFAULT_COOKIE_NAME,
  DEFAULT_MAX_AGE_MS,
  type Exchange,
  type Session,
  type Sessions,
} from "./sessions.js";
export {
  cookieFrom,
  isCrossSiteWrite,
  type Access,
  type AccessGate,
  type Refusal,
} from "./access.js";
export type {
  ActRefusal,
  Admission,
  AdmitRefusal,
  Admitted,
  Entry,
  Invite,
  Member,
  Members,
  Removed,
  RoleChanged,
} from "./members.js";
