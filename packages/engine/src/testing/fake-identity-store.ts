import { randomUUID } from "node:crypto";
import type { Database } from "@shopping-assistant/database";
import type { AuthIdentityStore } from "../accounts.ts";

/** Mirrors Better Auth: a duplicate email is refused, not silently reused. */
export class DuplicateIdentityError extends Error {
  constructor() {
    super("Identity already exists");
    this.name = "DuplicateIdentityError";
  }
}

export interface FakeIdentity {
  id: string;
  email: string;
  name: string;
  password: string;
}

/**
 * Stands in for the web layer's Better Auth instance in engine tests, which
 * need an identity to exist but do not exercise authentication itself.
 */
export function createFakeIdentityStore(database: Database): AuthIdentityStore & {
  identities: FakeIdentity[];
  passwordOf: (email: string) => string | undefined;
  exists: (email: string) => Promise<boolean>;
} {
  const identities: FakeIdentity[] = [];
  return {
    identities,
    passwordOf: (email) => identities.find((identity) => identity.email === email)?.password,
    async exists(email) {
      const row = await database("user").where({ email }).first("id");
      return Boolean(row);
    },
    async createUser(identity, connection) {
      // A previous attempt's identity may have been removed from the database
      // after a failure, so the address is only taken while the row survives.
      const stored = await connection("user")
        .where({ email: identity.email })
        .first("id");
      if (stored) throw new DuplicateIdentityError();
      const created = { ...identity, id: randomUUID() };
      // The profile's foreign key needs the identity to be stored where the
      // caller's transaction can see it, exactly as Better Auth would.
      await connection("user").insert({
        id: created.id,
        name: created.name,
        email: created.email,
        createdAt: connection.fn.now(),
        updatedAt: connection.fn.now(),
      });
      identities.push(created);
      return { id: created.id };
    },
    async findUserByEmail(email) {
      // The database is the record: a removed identity stops existing, exactly
      // as Better Auth would stop finding it.
      const identity = identities.find((known) => known.email === email);
      if (!identity) return undefined;
      const stored = await this.exists(email);
      return stored ? { id: identity.id, email: identity.email } : undefined;
    },
    async revokeSessions() {
      // Nothing to revoke: this store never issues a session. Disabling still
      // deletes the installation's own session rows, which the engine owns.
    },
  };
}
