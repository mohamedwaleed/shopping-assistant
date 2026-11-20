// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function newAuthenticatorSecret(): string {
  return Array.from(randomBytes(20), (byte) => ALPHABET[byte & 31]).join("");
}

function decodeBase32(value: string): Buffer {
  let bits = 0; let available = 0; const bytes: number[] = [];
  for (const character of value.replace(/=|\s/g, "").toUpperCase()) {
    const index = ALPHABET.indexOf(character); if (index < 0) throw new Error("invalid authenticator secret");
    bits = (bits << 5) | index; available += 5;
    if (available >= 8) { bytes.push((bits >>> (available - 8)) & 255); available -= 8; }
  }
  return Buffer.from(bytes);
}

export function authenticatorCode(secret: string, at: Date): string {
  const counter = Math.floor(at.getTime() / 30_000);
  const input = Buffer.alloc(8); input.writeUInt32BE(Math.floor(counter / 0x100000000), 0); input.writeUInt32BE(counter >>> 0, 4);
  const digest = createHmac("sha1", decodeBase32(secret)).update(input).digest();
  const offset = digest[19]! & 15;
  return String(((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000)).padStart(6, "0");
}

export function validAuthenticatorCode(secret: string, code: string, at: Date): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  return [-30_000, 0, 30_000].some((offset) => {
    const expected = Buffer.from(authenticatorCode(secret, new Date(at.getTime() + offset)));
    return timingSafeEqual(expected, Buffer.from(code));
  });
}

export function newRecoveryCodes(): string[] { return Array.from({ length: 10 }, () => randomBytes(5).toString("hex")); }
export function recoveryCodeHash(code: string): string { return createHash("sha256").update(code.trim()).digest("hex"); }
