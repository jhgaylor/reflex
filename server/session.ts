/**
 * The browser's half of "signed in": one opaque cookie, and nothing else.
 *
 * Rounds put credentials in `localStorage` — a Fountain API key and a GitHub
 * user token — because the page was the client and had to hold them. Ward's
 * page is not a client of anything but Ward, so it holds no credential at
 * all: it carries a session id that means nothing outside this process, and
 * every token it used to hold now lives server-side against that session.
 *
 * The cookie is `HttpOnly`, so script cannot read it, which is the property
 * `localStorage` could never have.
 *
 * `SameSite=Lax` rather than `Strict`, deliberately: signing in ends with
 * GitHub performing a top-level cross-site redirect back to the app root,
 * and `Strict` withholds the cookie on exactly that navigation — the session
 * would be set and then appear missing on the next page load. `Lax` sends it
 * on top-level GETs and withholds it from cross-site POSTs, which is the
 * shape of the threat that matters here.
 */
import crypto from "node:crypto";

export const COOKIE_NAME = "reflex_session";

/** Long enough not to nag, short enough that a forgotten browser lapses. */
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * The value handed to the browser: 32 random bytes, meaningful only as a
 * lookup key. Nothing is encoded in it — not the user, not the expiry — so
 * there is nothing in it to forge.
 */
export function newSessionToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/**
 * What the database stores. The raw token is a bearer credential, so the
 * table holds its SHA-256 instead: read access to `sessions` then yields no
 * ability to *be* anybody, which is the same reason nobody stores passwords.
 *
 * Plain SHA-256 rather than a password hash on purpose — the input is 256
 * bits of entropy we generated, so there is no dictionary to stretch against.
 */
export function tokenDigest(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export interface CookieOptions {
  /** Omit `Secure` for plain-http local development; always true in deployment. */
  secure: boolean;
  maxAgeSeconds?: number;
}

export function sessionCookie(token: string, opts: CookieOptions): string {
  const parts = [
    `${COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${opts.maxAgeSeconds ?? SESSION_TTL_SECONDS}`,
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

/** The same cookie, expired — what sign-out sends. */
export function clearedCookie(opts: CookieOptions): string {
  return sessionCookie("", { ...opts, maxAgeSeconds: 0 });
}

/** Read our cookie out of a request, or null. */
export function sessionToken(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() !== COOKIE_NAME) continue;
    const value = pair.slice(eq + 1).trim();
    return value || null;
  }
  return null;
}

/**
 * Whether to mark cookies `Secure`, decided from the request rather than
 * configured. Behind the cluster's ingress the app speaks http, so the
 * scheme on the URL is not the scheme the browser used — `x-forwarded-proto`
 * is. Getting this wrong in the safe direction (marking Secure on plain
 * http) makes sign-in silently fail, so localhost is the explicit exception.
 */
export function secureFor(req: Request, url: URL): boolean {
  const forwarded = req.headers.get("x-forwarded-proto");
  if (forwarded) return forwarded.split(",")[0]!.trim() === "https";
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return false;
  return url.protocol === "https:";
}
