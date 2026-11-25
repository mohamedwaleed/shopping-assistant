import { randomUUID } from "node:crypto";
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
export function createFakeIdentityStore(): AuthIdentityStore & {
  identities: FakeIdentity[];
  passwordOf: (email: string) => string | undefined;
} {
  const identities: FakeIdentity[] = [];
  return {
    identities,
    passwordOf: (email) => identities.find((identity) => identity.email === email)?.password,
    async createUser(identity, connection) {
      if (identities.some((known) => known.email === identity.email)) throw new DuplicateIdentityError();
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
      const identity = identities.find((known) => known.email === email);
      return identity ? { id: identity.id, email: identity.email } : undefined;
    },
  };
}
