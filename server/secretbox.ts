/**
 * Authenticated encryption for the few things Ward stores that would be a
 * credential if the table leaked.
 *
 * Exactly one kind of value goes through here today: the GitHub user token.
 * Rounds never had this problem — the token lived in the browser that owned
 * it, and this process saw it only for the length of one request. Ward keeps
 * it, because the server now does the repository listing and the grant
 * minting on the person's behalf, and a stolen `github_tokens` table would
 * otherwise be a stolen set of GitHub accounts.
 *
 * The key is derived from `REFLEX_SECRET` rather than provisioned separately.
 * One secret to hold is worth more than the independence of two, and HKDF
 * with distinct `info` strings makes the encryption key and the grant signing
 * key cryptographically unrelated — knowing either tells you nothing about
 * the other.
 *
 * The cost of that choice, and it is a real one: rotating `REFLEX_SECRET`
 * invalidates every outstanding grant *and* every stored GitHub token at
 * once. Both recover the same way — sign in again, enroll again — and neither
 * fails silently, because an unopenable box is treated as no token at all.
 */
import crypto from "node:crypto";

/** Bumped only if the construction changes; `open` refuses anything else. */
const VERSION = "v1";

/** Distinct from any other derivation, so the keys cannot collide. */
const INFO = "reflex/secretbox/fountain-key";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function keyFrom(secret: string): Buffer {
  // No salt: the input is already a high-entropy secret rather than a
  // password, and a fixed empty salt keeps derivation deterministic across
  // processes, which is what lets two replicas open each other's boxes.
  return Buffer.from(crypto.hkdfSync("sha256", secret, "", INFO, KEY_BYTES));
}

/** `v1.<iv|tag|ciphertext base64url>` */
export function seal(plaintext: string, secret: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyFrom(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${VERSION}.${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url")}`;
}

/**
 * Decrypt, or null for anything that is not a box we sealed with this secret —
 * including one whose ciphertext has been edited, which GCM catches.
 *
 * Null rather than throwing on purpose: every caller's correct response is
 * the same as for a missing row ("this person has no usable token, send them
 * through sign-in again"), and a throw would turn a rotated secret into a
 * crash loop instead of a re-authorization.
 */
export function open(sealed: string | null | undefined, secret: string): string | null {
  if (!sealed) return null;
  const [version, body] = sealed.split(".");
  if (version !== VERSION || !body) return null;

  const raw = Buffer.from(body, "base64url");
  if (raw.length <= IV_BYTES + TAG_BYTES) return null;

  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", keyFrom(secret), raw.subarray(0, IV_BYTES));
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
