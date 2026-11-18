// SPDX-License-Identifier: AGPL-3.0-or-later
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import {
  INSTALLATION_SECRET_ENV,
  MINIMUM_INSTALLATION_SECRET_LENGTH,
} from "../installation-secret";

/**
 * Provider credentials are stored encrypted with an installation secret that
 * lives outside PostgreSQL (docs/adr/0012). AES-256-GCM is authenticated, so a
 * tampered or foreign ciphertext fails to decrypt instead of yielding a key.
 */
export const SECRET_ENCRYPTION = "aes-256-gcm";

export interface SecretCipher {
  readonly encryption: typeof SECRET_ENCRYPTION;
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
}

const IV_BYTES = 12;
const TAG_BYTES = 16;

export function createSecretCipher(input: { key: string }): SecretCipher {
  if (input.key.length < MINIMUM_INSTALLATION_SECRET_LENGTH) {
    throw new Error(
      `${INSTALLATION_SECRET_ENV} must be at least ${MINIMUM_INSTALLATION_SECRET_LENGTH} characters`,
    );
  }
  const key = createHash("sha256").update(input.key, "utf8").digest();

  return {
    encryption: SECRET_ENCRYPTION,
    encrypt(plaintext) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(SECRET_ENCRYPTION, key, iv);
      const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(
        ".",
      );
    },
    decrypt(ciphertext) {
      const [version, iv, tag, body] = ciphertext.split(".");
      if (version !== "v1" || !iv || !tag || !body) {
        throw new Error("unsupported credential ciphertext");
      }
      const tagBytes = Buffer.from(tag, "base64url");
      if (tagBytes.length !== TAG_BYTES) throw new Error("unsupported credential ciphertext");
      const decipher = createDecipheriv(SECRET_ENCRYPTION, key, Buffer.from(iv, "base64url"));
      decipher.setAuthTag(tagBytes);
      return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
    },
  };
}

/**
 * Short, stable hint shown in settings and API responses: enough for a person
 * to recognise which key is stored, never enough to use it.
 */
export function maskSecret(secret: string): string {
  const trimmed = secret.trim();
  if (trimmed.length <= 8) return "…";
  return `${trimmed.slice(0, 3)}…${trimmed.slice(-3)}`;
}
