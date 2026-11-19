// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { createSecretCipher, maskSecret } from "../src/index";

// Credentials are only as safe as the cipher: a foreign, truncated or tampered
// ciphertext must fail closed rather than yield a key.
const KEY = "installation-secret-0123456789abcdef";

describe("secret cipher", () => {
  it("round-trips a key without storing it in plaintext", () => {
    const cipher = createSecretCipher({ key: KEY });
    const ciphertext = cipher.encrypt("sk-live-0123456789");

    expect(ciphertext).not.toContain("sk-live");
    expect(cipher.encryption).toBe("aes-256-gcm");
    expect(cipher.decrypt(ciphertext)).toBe("sk-live-0123456789");
  });

  it("produces a different ciphertext for the same key each time", () => {
    const cipher = createSecretCipher({ key: KEY });
    expect(cipher.encrypt("sk-live-0123456789")).not.toBe(cipher.encrypt("sk-live-0123456789"));
  });

  it("refuses a ciphertext written under another installation secret", () => {
    const written = createSecretCipher({ key: KEY }).encrypt("sk-live-0123456789");
    const other = createSecretCipher({ key: "another-installation-secret-0123456789" });
    expect(() => other.decrypt(written)).toThrow();
  });

  it("refuses a tampered ciphertext", () => {
    const cipher = createSecretCipher({ key: KEY });
    const [version, iv, tag, body] = cipher.encrypt("sk-live-0123456789").split(".");
    const flipped = Buffer.from(body!, "base64url");
    flipped[0] = flipped[0]! ^ 0xff;
    expect(() => cipher.decrypt([version, iv, tag, flipped.toString("base64url")].join("."))).toThrow();
    expect(() => cipher.decrypt("not-a-ciphertext")).toThrow();
  });

  it("requires an installation secret of usable length", () => {
    expect(() => createSecretCipher({ key: "short" })).toThrow(/INSTALLATION_SECRET/);
  });

  it("masks a key to a recognisable hint", () => {
    expect(maskSecret("sk-live-0123456789")).toBe("sk-…789");
    expect(maskSecret("short")).toBe("…");
  });
});
