// The id of a visitor nobody knows yet, and which requests are never counted.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type Visitors = {
  /** A new random id and the cookie value that carries it: the id, a dot, and its signature. */
  mint(): { id: string; cookie: string };
  /** The id inside a cookie this secret signed, or null for anything else. */
  read(cookie: string | null | undefined): string | null;
};

// 16 random bytes in base64url, and an HMAC-SHA256 in base64url.
const SIGNED = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;

/**
 * Signs visitor ids. An id nobody signed could be minted by any script, and each one adds a unit to an
 * arm's count. A signed id costs its maker one real page load. The secret comes from a secret manager,
 * and anything shorter than 32 characters is refused.
 */
export function createVisitors(config: { secret: string | undefined }): Visitors {
  const secret = config.secret;
  if (!secret || secret.length < 32)
    throw new Error("the visitor secret must have 32 characters or more");
  const sign = (id: string) => createHmac("sha256", secret).update(id).digest();
  return {
    mint() {
      const id = randomBytes(16).toString("base64url");
      return { id, cookie: `${id}.${sign(id).toString("base64url")}` };
    },
    read(cookie) {
      const [, id, signature] = SIGNED.exec(cookie ?? "") ?? [];
      if (!id || !signature) return null;
      return timingSafeEqual(Buffer.from(signature, "base64url"), sign(id)) ? id : null;
    },
  };
}

type RequestHeaders = { get(name: string): string | null };

// Crawlers, link previews, scripts and headless browsers. A person's browser names none of these.
const ROBOT =
  /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|curl|wget|python|java\/|go-http|okhttp|axios|node-fetch|headless|lighthouse|pagespeed|phantom|puppeteer|playwright/i;

// Firebase App Hosting's CDN puts its own user agent in place of the client's.
const CDN_USER_AGENTS = new Set(["Google", "Cloud-CDN-Google"]);

/**
 * A request from a robot, or with no user agent. Behind App Hosting's CDN the user agent says nothing,
 * so the request is judged by Fetch Metadata there: browsers send `Sec-Fetch-Mode` on every HTTPS
 * request, a page's script cannot set it, and curl, crawlers and HTTP libraries do not send it.
 */
export function isRobot(headers: RequestHeaders): boolean {
  const userAgent = headers.get("user-agent");
  if (userAgent !== null && CDN_USER_AGENTS.has(userAgent))
    return headers.get("sec-fetch-mode") === null;
  return !userAgent || ROBOT.test(userAgent);
}

/** A page the browser fetched ahead of a click that may never come. */
export function isPrefetch(headers: RequestHeaders): boolean {
  return /prefetch/i.test(`${headers.get("sec-purpose") ?? ""} ${headers.get("purpose") ?? ""}`);
}

/** A browser sending Global Privacy Control: its person asked not to be tracked. */
export function refusesTracking(headers: RequestHeaders): boolean {
  return headers.get("sec-gpc") === "1";
}
