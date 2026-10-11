// Whether a request may act, and the 401 or 403 a route answers otherwise.
//
// The tenant comes only from the verified cookie's claims. A request's body, its query and the
// environment never name it.
import type { PermissionOf, RoleMap, RoleOf, Roles } from "./roles.js";
import type { Sessions } from "./sessions.js";

/**
 * `cross_site`: a write another site's page sent with the user's cookie. `no_session`: no cookie, or one
 * that no longer verifies. `no_tenant`: a signed-in user no tenant has admitted. `forbidden`: the role
 * does not hold the permission.
 */
export type Refusal = "cross_site" | "no_session" | "no_tenant" | "forbidden";

export type Access<R extends RoleMap> =
  | { ok: true; tenantId: string; uid: string; email: string; role: RoleOf<R> }
  | { ok: false; status: 401 | 403; reason: Refusal };

// A read changes nothing, so another site linking to one does no harm. Every other method writes.
const READS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

const first = (value: string | null) => value?.split(",")[0]?.trim() || null;

/**
 * The host the user reached this request on. Behind a proxy the request's own URL names the container,
 * so the forwarded host comes first.
 */
function publicHost(request: Request): string {
  return (
    first(request.headers.get("x-forwarded-host")) ??
    first(request.headers.get("host")) ??
    new URL(request.url).host
  );
}

/**
 * Whether `request` is a write that did not come from this site's own pages (CSRF). A browser says
 * where a request came from in `Sec-Fetch-Site`, and in `Origin` on every write. A write that carries
 * neither is refused: no browser sends one, and nothing else should hold the cookie.
 */
export function isCrossSiteWrite(request: Request): boolean {
  if (READS.has(request.method.toUpperCase())) return false;
  const site = request.headers.get("sec-fetch-site");
  if (site) return site !== "same-origin";
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host !== publicHost(request);
  } catch {
    return true;
  }
}

/** One cookie's value from a request's `Cookie` header. */
export function cookieFrom(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const pair of header.split(";")) {
    const at = pair.indexOf("=");
    if (at > 0 && pair.slice(0, at).trim() === name)
      return pair.slice(at + 1).trim() || undefined;
  }
  return undefined;
}

export type AccessConfig<R extends RoleMap> = {
  sessions: Sessions<R>;
  roles: Roles<R>;
  cookieName: string;
};

export type AccessGate<R extends RoleMap> = {
  /**
   * What every route handler opens with:
   *
   *     const access = await auth.access.require(request, "write");
   *     if (!access.ok) return Response.json({ error: access.reason }, { status: access.status });
   */
  require(request: Request, permission: PermissionOf<R>): Promise<Access<R>>;
};

export function createAccess<R extends RoleMap>(config: AccessConfig<R>): AccessGate<R> {
  const { sessions, roles, cookieName } = config;
  const refuse = (status: 401 | 403, reason: Refusal) =>
    ({ ok: false, status, reason }) as const;

  return {
    async require(request, permission) {
      // Before the session is read: a forged write costs no Auth call.
      if (isCrossSiteWrite(request)) return refuse(403, "cross_site");
      const session = await sessions.read(cookieFrom(request, cookieName));
      if (!session) return refuse(401, "no_session");
      if (!session.tenantId || !session.role) return refuse(403, "no_tenant");
      if (!roles.can(session.role, permission)) return refuse(403, "forbidden");
      return {
        ok: true,
        tenantId: session.tenantId,
        uid: session.uid,
        email: session.email,
        role: session.role,
      };
    },
  };
}
