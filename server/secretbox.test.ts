import { describe, expect, test } from "bun:test";
import { open, seal } from "./secretbox";

const SECRET = "a-grant-secret-with-plenty-of-entropy";

describe("secretbox", () => {
  test("a sealed value opens back to itself", () => {
    expect(open(seal("ghu_abc123", SECRET), SECRET)).toBe("ghu_abc123");
  });

  test("sealing twice gives different ciphertexts", () => {
    // A fresh IV each time, so two users with the same token do not produce
    // the same row — otherwise the table leaks which accounts match.
    expect(seal("same", SECRET)).not.toBe(seal("same", SECRET));
  });

  test("the plaintext never appears in the box", () => {
    expect(seal("ghu_secret_value", SECRET)).not.toContain("ghu_secret_value");
  });

  test("a different secret does not open it", () => {
    expect(open(seal("ghu_abc123", SECRET), "some-other-secret")).toBeNull();
  });

  test("an edited box does not open", () => {
    // GCM authenticates the ciphertext; flipping a byte has to be caught
    // rather than yielding plausible garbage.
    const sealed = seal("ghu_abc123", SECRET);
    const body = sealed.slice(3);
    const tampered = `v1.${body.slice(0, -2)}${body.slice(-2) === "AA" ? "BB" : "AA"}`;
    expect(open(tampered, SECRET)).toBeNull();
  });

  test("rubbish opens to null rather than throwing", () => {
    // Every one of these reaches `open` as a stored value at some point: a
    // rotated secret, a truncated column, a version that predates this code.
    for (const bad of ["", "v1.", "v1.!!!!", "v2.abc", "not-a-box", undefined, null]) {
      expect(open(bad, SECRET)).toBeNull();
    }
  });

  test("round-trips values with newlines and unicode", () => {
    const awkward = "line\nline\t— ünïcodé 🔐";
    expect(open(seal(awkward, SECRET), SECRET)).toBe(awkward);
  });
});
