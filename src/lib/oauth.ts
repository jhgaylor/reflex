/**
 * "Sign in with Fountain": OAuth 2.0 authorization code + PKCE (S256), public
 * client. The token that comes back is a Fountain API key; the page hands it
 * to the Reflex server once (POST /api/session) and forgets it. The owner
 * never sees a key.
 *
 * Fountain registers this client by id and exact redirect URI
 * (OAUTH_CLIENTS on the server). The redirect is this app's own root.
 */

const CLIENT_ID = "reflex";
const STASH = "reflex.oauth";
export const DEFAULT_FOUNTAIN = "https://fountain.inevitable.fyi";

function base64url(bytes: ArrayBuffer): string {
  let s = "";
  const b = new Uint8Array(bytes);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(bytes = 32): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return base64url(a.buffer);
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(digest);
}

export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** Must match a `redirect_uris` entry registered for the client. Always the root. */
export function redirectUri(): string {
  return window.location.origin + "/";
}

export async function beginLogin(baseUrl: string = DEFAULT_FOUNTAIN): Promise<void> {
  const verifier = randomString();
  const state = randomString(16);
  const challenge = await challengeFor(verifier);
  const base = normalizeBaseUrl(baseUrl);
  sessionStorage.setItem(STASH, JSON.stringify({ verifier, state, baseUrl: base }));
  const q = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  window.location.href = `${base}/oauth/authorize?${q}`;
}

export interface CallbackResult {
  baseUrl: string;
  apiKey: string;
}

/** True when this page load is an OAuth redirect (checked synchronously at boot). */
export function isCallback(): boolean {
  return /[?&](code|error)=/.test(window.location.search);
}

/** null when this page load is not an OAuth callback; throws on a real failure. */
export async function completeLoginIfCallback(): Promise<CallbackResult | null> {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const error = params.get("error");
  const state = params.get("state");
  if (!code && !error) return null;

  const stashed = sessionStorage.getItem(STASH);
  sessionStorage.removeItem(STASH);
  clearOAuthParams();

  if (error) throw new Error(error === "access_denied" ? "Sign-in was cancelled." : "Sign-in did not go through. Try again.");
  if (!stashed) throw new Error("Sign-in could not be completed in this browser. Try again.");

  const { verifier, state: expected, baseUrl } = JSON.parse(stashed) as { verifier: string; state: string; baseUrl: string };
  if (!state || state !== expected) throw new Error("Sign-in did not match up. Try again.");

  const res = await fetch(`${baseUrl}/api/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: CLIENT_ID, redirect_uri: redirectUri() }),
  });
  if (!res.ok) throw new Error("Fountain did not accept the sign-in. Try again.");
  const body = (await res.json()) as { access_token: string };
  return { baseUrl, apiKey: body.access_token };
}

function clearOAuthParams(): void {
  const url = new URL(window.location.href);
  ["code", "state", "error", "error_description"].forEach((k) => url.searchParams.delete(k));
  window.history.replaceState({}, "", url.pathname + url.search + url.hash);
}
