import { describe, expect, test } from "bun:test";
import { clearedCookie, COOKIE_NAME, newSessionToken, secureFor, sessionCookie, sessionToken, tokenDigest } from "./session";

const req = (headers: Record<string, string> = {}) => new Request("http://localhost:5181/", { headers });

describe("session tokens", () => {
  test("are unguessable and distinct", () => {
    const seen = new Set(Array.from({ length: 200 }, newSessionToken));
    expect(seen.size).toBe(200);
    // 32 bytes, base64url — no padding, nothing needing escaping in a cookie.
    for (const token of seen) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("the digest is what gets stored, and it is not the token", () => {
    const token = newSessionToken();
    const digest = tokenDigest(token);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain(token);
    expect(tokenDigest(token)).toBe(digest);
  });
});

describe("the cookie", () => {
  test("is HttpOnly and Lax, so script cannot read it and sign-in still works", () => {
    const cookie = sessionCookie("abc", { secure: true });
    expect(cookie).toContain(`${COOKIE_NAME}=abc`);
    expect(cookie).toContain("HttpOnly");
    // Lax rather than Strict: GitHub's redirect back to /gh/callback is a
    // cross-site top-level navigation, and Strict would withhold the cookie
    // on precisely that request.
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("Path=/");
  });

  test("omits Secure for plain-http development", () => {
    expect(sessionCookie("abc", { secure: false })).not.toContain("Secure");
  });

  test("clearing sends an immediate expiry", () => {
    expect(clearedCookie({ secure: true })).toContain("Max-Age=0");
  });

  test("is read back out of a request", () => {
    expect(sessionToken(req({ cookie: `${COOKIE_NAME}=xyz` }))).toBe("xyz");
  });

  test("is found among other cookies", () => {
    expect(sessionToken(req({ cookie: `other=1; ${COOKIE_NAME}=xyz; third=3` }))).toBe("xyz");
  });

  test("is null when absent, empty or malformed", () => {
    expect(sessionToken(req())).toBeNull();
    expect(sessionToken(req({ cookie: "other=1" }))).toBeNull();
    expect(sessionToken(req({ cookie: `${COOKIE_NAME}=` }))).toBeNull();
    expect(sessionToken(req({ cookie: "novalue" }))).toBeNull();
  });

  test("does not match a cookie whose name merely ends with ours", () => {
    expect(sessionToken(req({ cookie: `not_${COOKIE_NAME}=xyz` }))).toBeNull();
  });
});

describe("secureFor", () => {
  test("trusts x-forwarded-proto, because behind the ingress we speak http", () => {
    const url = new URL("http://ward.inevitable.fyi/");
    expect(secureFor(req({ "x-forwarded-proto": "https" }), url)).toBe(true);
    expect(secureFor(req({ "x-forwarded-proto": "http" }), url)).toBe(false);
  });

  test("reads only the first hop of a chained header", () => {
    expect(secureFor(req({ "x-forwarded-proto": "https, http" }), new URL("http://ward.inevitable.fyi/"))).toBe(true);
  });

  test("localhost is insecure, so development actually works", () => {
    expect(secureFor(req(), new URL("http://localhost:5181/"))).toBe(false);
    expect(secureFor(req(), new URL("http://127.0.0.1:5181/"))).toBe(false);
  });

  test("falls back to the url scheme", () => {
    expect(secureFor(req(), new URL("https://ward.inevitable.fyi/"))).toBe(true);
  });
});
