import { randomBytes } from "node:crypto";
import type { Database } from "@shopping-assistant/database";
import type { AuthIdentityStore } from "./accounts.ts";

/** An hour is long enough for a real inbox and short enough to leak little. */
export const RESET_LIFETIME_MS = 60 * 60 * 1_000;

/** Better Auth stores reset tokens as verification values under this prefix. */
const RESET_IDENTIFIER_PREFIX = "reset-password:";

/**
 * Raised for every refusal — unknown, spent, and expired tokens alike. Telling
 * them apart would confirm which links once existed, and a message never
 * repeats the token it was given.
 */
export class ResetTokenInvalidError extends Error {
  constructor() {
    super("The reset link is invalid, expired, or already used");
    this.name = "ResetTokenInvalidError";
  }
}

/** No SMTP relay is configured, so a reset link could never be delivered. */
export class EmailUnavailableError extends Error {
  constructor() {
    super("Email is not configured for this installation, so links cannot be sent");
    this.name = "EmailUnavailableError";
  }
}

/**
 * How identities are handed a new password. The engine decides when a reset is
 * allowed; the web layer owns the credential and writes it, so the engine never
 * handles a hash.
 */
export interface PasswordSetter {
  setPassword(identityId: string, password: string): Promise<void>;
}

export interface PasswordResets {
  /**
   * Sends a reset link to the account an address belongs to. Answers the same
   * way whether or not an account exists, so it cannot be used to discover
   * which addresses have one.
   */
  request(input: { email: string }): Promise<void>;
  /**
   * Sets the password the link was issued for. The token is spent by the same
   * statement that checks it, so simultaneous or replayed use fails.
   */
  complete(input: { token: string; password: string }): Promise<void>;
}

interface ResetRow {
  id: string;
  value: string;
  expiresAt: Date;
}

export function createPasswordResets({
  database,
  identities,
  passwords,
  mailer,
  baseUrl,
  now = () => new Date(),
}: {
  database: Database;
  identities: AuthIdentityStore;
  passwords: PasswordSetter;
  /** Absent when the installation has no SMTP relay; requesting then fails explicitly. */
  mailer?: { send(message: { to: string; subject: string; text: string }): Promise<void> };
  /** The origin shoppers reach; the emailed link is built from it. */
  baseUrl: string;
  /** The clock, so expiry can be tested without waiting. */
  now?: () => Date;
}): PasswordResets {
  return {
    async request(input) {
      if (!mailer) throw new EmailUnavailableError();
      const email = input.email.trim().toLowerCase();
      const identity = await identities.findUserByEmail(email);
      // The work below is skipped for an unknown address, but the caller cannot
      // see that: the same outcome is reported either way.
      if (!identity) return;

      const issuedAt = now();
      const token = randomBytes(32).toString("base64url");
      await database("verification").insert({
        identifier: `${RESET_IDENTIFIER_PREFIX}${token}`,
        // The value names the account, as Better Auth's own reset flow stores
        // it, so the column holds no password and no separate copy of the token.
        value: identity.id,
        expiresAt: new Date(issuedAt.getTime() + RESET_LIFETIME_MS),
        createdAt: issuedAt,
        updatedAt: issuedAt,
      });

      const url = `${baseUrl}/api/auth/reset-password?token=${token}`;
      try {
        await mailer.send({
          to: identity.email,
          subject: "Reset your password",
          text: `Choose a new password with this link: ${url}`,
        });
      } catch (error) {
        // An undelivered link would otherwise sit in the table until it expired,
        // leaving the requester waiting for mail that is never coming.
        await database("verification").where({ identifier: `${RESET_IDENTIFIER_PREFIX}${token}` }).del();
        throw error;
      }
    },

    async complete(input) {
      await database.transaction(async (transaction) => {
        // Single use comes from this one statement: the row is deleted in the
        // same write that checks it exists and is unexpired, so two racers
        // cannot both be told the token is good. Reading first would let both
        // read "valid" before either deleted.
        const consumed = await transaction("verification")
          .where({ identifier: `${RESET_IDENTIFIER_PREFIX}${input.token}` })
          .where("expiresAt", ">", now())
          .del()
          .returning<ResetRow[]>(["id", "value", "expiresAt"]);
        const row = consumed[0];
        if (!row) throw new ResetTokenInvalidError();
        await passwords.setPassword(row.value, input.password);
      });
    },
  };
}
