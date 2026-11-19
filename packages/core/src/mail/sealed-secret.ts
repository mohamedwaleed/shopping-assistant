// SPDX-License-Identifier: AGPL-3.0-or-later
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const KEY_SALT = "shopping-assistant:mail-credentials:v1";

/**
 * Secrets at rest are encrypted with an installation secret held outside the
 * database (docs/decisions.md round five), so a database dump alone does not
 * reveal them. AES-256-GCM authenticates the ciphertext, so a wrong secret is
 * detected rather than silently producing garbage.
 */
function key(installationSecret: string): Buffer {
  return scryptSync(installationSecret, KEY_SALT, KEY_LENGTH);
}

export function sealSecret(plaintext: string, installationSecret: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key(installationSecret), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

export function openSecret(sealed: string, installationSecret: string): string {
  const [version, iv, tag, ciphertext] = sealed.split(":");
  if (version !== "v1" || !iv || !tag || ciphertext === undefined) {
    throw new Error("unrecognised sealed secret");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key(installationSecret),
    Buffer.from(iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
