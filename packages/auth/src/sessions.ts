// How an ID token becomes a session cookie, how that cookie becomes a user, and how signing out ends it.
//
// The browser sends its ID token once. The server verifies it and answers an HttpOnly session cookie.
// Every later request carries only the cookie, which the server verifies with firebase-admin
// (revocation checked) and reads against the claims the account holds now.
import type { Auth, DecodedIdToken } from "firebase-admin/auth";
import { accountByUid, grantOf, sameGrant, type Grant } from "./claims.js";
import type { RoleMap, Roles } from "./roles.js";

/** The one cookie Firebase Hosting forwards to a backend. */
export const DEFAULT_COOKIE_NAME = "__session";
/** Five days, inside the fourteen Firebase allows a session cookie. */
export const DEFAULT_MAX_AGE_MS = 5 * 24 * 60 * 60 * 1000;
const DEFAULT_RECENT_SIGN_IN_SECONDS = 5 * 60;

/** Who a verified session is. `tenantId` and `role` are null for a user no tenant has admitted. */
export type Session<R extends RoleMap> = Grant<R> & {
  uid: string;
  email: string;
};

export type Exchange<R extends RoleMap> =
  | { ok: true; cookie: string; session: Session<R> }
  | { ok: false; reason: "token" | "email_unverified" | "stale_sign_in" };

export type SessionsConfig<R extends RoleMap> = {
  auth: Auth;
  roles: Roles<R>;
  /** How long a session lasts. Default five days. Firebase allows five minutes to fourteen days. */
  maxAgeMs?: number;
  /** A sign-in older than this is not exchanged: the token could have been lifted from elsewhere. Default 300. */
  recentSignInSeconds?: number;
};

export type Sessions<R extends RoleMap> = {
  readonly maxAgeMs: number;
  /** Exchanges a fresh ID token of a verified e-mail for a session cookie. */
  exchange(idToken: string, nowSeconds?: number): Promise<Exchange<R>>;
  /**
   * The session a cookie carries. Null when there is none, it expired, it was revoked, or the account no
   * longer holds the tenant or role the cookie grants.
   */
  read(cookie: string | undefined): Promise<Session<R> | null>;
  /**
   * Signs out on the server. Clearing the cookie alone leaves it valid until it expires, so a copy of it
   * would go on working. This revokes the user's refresh tokens, which ends every session of theirs on
   * every device. False when the cookie carried no session.
   */
  end(cookie: string | undefined): Promise<boolean>;
};

// What firebase-admin answers when the token or cookie itself is bad: expired, revoked, forged,
// malformed, or its user disabled or gone. Anything else (Auth down, a credential that cannot fetch
// keys) is not the user's session ending, so it is thrown and the route answers 500.
const INVALID_CREDENTIAL: ReadonlySet<string> = new Set([
  "auth/argument-error",
  "auth/invalid-argument",
  "auth/id-token-expired",
  "auth/id-token-revoked",
  "auth/invalid-id-token",
  "auth/session-cookie-expired",
  "auth/session-cookie-revoked",
  "auth/invalid-session-cookie",
  "auth/user-disabled",
  "auth/user-not-found",
]);

function nullWhenInvalid(error: unknown): null {
  if (INVALID_CREDENTIAL.has((error as { code?: string }).code ?? ""))
    return null;
  throw error;
}

/**
 * Whether the token's payload reads as a JSON value other than null. firebase-admin decodes a token
 * before it checks anything, and a payload that is not JSON makes that decode throw a bare SyntaxError
 * (a bare TypeError for `null`), which is no `auth/*` code: a stranger's crafted cookie would become a
 * 500. Judged here, from the string alone, so a parse error of any other origin is never read as "no
 * session". A string that is not three parts is Auth's to refuse.
 */
function readablePayload(token: string): boolean {
  const payload = token.split(".")[1];
  if (payload === undefined) return true;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) !== null;
  } catch {
    return false;
  }
}

export function createSessions<R extends RoleMap>(
  config: SessionsConfig<R>,
): Sessions<R> {
  const { auth, roles } = config;
  const maxAgeMs = config.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const recent = config.recentSignInSeconds ?? DEFAULT_RECENT_SIGN_IN_SECONDS;

  const sessionOf = (claims: DecodedIdToken): Session<R> => ({
    uid: claims.uid,
    email: claims.email ?? "",
    ...grantOf(claims, roles),
  });

  async function verified(cookie: string | undefined): Promise<DecodedIdToken | null> {
    if (!cookie || !readablePayload(cookie)) return null;
    return auth.verifySessionCookie(cookie, true).catch(nullWhenInvalid);
  }

  async function exchange(
    idToken: string,
    nowSeconds = Date.now() / 1000,
  ): Promise<Exchange<R>> {
    if (!readablePayload(idToken)) return { ok: false, reason: "token" };
    const claims = await auth.verifyIdToken(idToken, true).catch(nullWhenInvalid);
    if (!claims) return { ok: false, reason: "token" };
    if (!claims.email_verified) return { ok: false, reason: "email_unverified" };
    if (nowSeconds - claims.auth_time > recent)
      return { ok: false, reason: "stale_sign_in" };
    const cookie = await auth.createSessionCookie(idToken, { expiresIn: maxAgeMs });
    return { ok: true, cookie, session: sessionOf(claims) };
  }

  // A revocation counts whole seconds, so a cookie minted during the second its user was revoked
  // survives it, and nothing else ties a five-day cookie to a claim changed since. Reading the account
  // costs one Auth read beside the one the revocation check makes.
  async function read(cookie: string | undefined): Promise<Session<R> | null> {
    const claims = await verified(cookie);
    if (!claims) return null;
    const session = sessionOf(claims);
    const account = await accountByUid(auth, session.uid);
    if (!account || account.disabled) return null;
    return sameGrant(session, grantOf(account.customClaims, roles)) ? session : null;
  }

  async function end(cookie: string | undefined): Promise<boolean> {
    const claims = await verified(cookie);
    if (!claims) return false;
    await auth.revokeRefreshTokens(claims.uid);
    return true;
  }

  return { maxAgeMs, exchange, read, end };
}
