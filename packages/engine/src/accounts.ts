import type { Database } from "@shopping-assistant/database";

/**
 * Identity creation belongs to the web layer, which owns Better Auth. The engine
 * only records what an identity is for: its role and whether more may exist.
 */
export interface AuthIdentity {
  email: string;
  name: string;
}

/** Anything that can build a query: the database itself or an open transaction. */
type Queryable = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * The narrow slice of authentication state the engine needs. Identity storage
 * belongs to Better Auth in the web layer; the engine only asks it to create
 * one, and to name the database it should write to so the identity and the
 * profile it belongs to commit or roll back together.
 */
export interface AuthIdentityStore {
  createUser(
    identity: AuthIdentity & { password: string },
    connection: Queryable,
  ): Promise<{ id: string }>;
  findUserByEmail(email: string): Promise<{ id: string; email: string } | undefined>;
}

export interface Account {
  id: string;
  email: string;
  role: "user" | "admin";
  createdAt: Date;
}

interface AccountRow {
  id: string;
  email: string;
  role: "user" | "admin";
  created_at: Date;
}

/** Public registration is closed by the installation's policy. */
export class RegistrationClosedError extends Error {
  constructor() {
    super("Public registration is closed");
    this.name = "RegistrationClosedError";
  }
}

/** Raised when an identity already has an account, so a profile is never doubled. */
export class AccountAlreadyExistsError extends Error {
  constructor() {
    super("An account already exists for this identity");
    this.name = "AccountAlreadyExistsError";
  }
}

export interface Accounts {
  /**
   * Records an ordinary account for an identity Better Auth has already
   * created. Refuses when the installation has closed public registration.
   */
  register(input: { identityId: string; email: string }): Promise<Account>;
  /**
   * The admin bootstrap's counterpart: it records the admin regardless of
   * policy, inside the transaction that claims the installation.
   */
  recordAdmin(
    input: { identityId: string; email: string },
    connection?: Queryable,
  ): Promise<Account>;
  findByEmail(email: string): Promise<Account | undefined>;
  isRegistrationOpen(): Promise<boolean>;
}

export function createAccounts({ database }: { database: Database }): Accounts {
  const toAccount = (row: AccountRow): Account => ({
    id: row.id,
    email: row.email,
    role: row.role,
    createdAt: row.created_at,
  });

  async function record(
    input: { identityId: string; email: string },
    role: Account["role"],
    connection: Queryable = database,
  ): Promise<Account> {
    const rows = await connection("profiles")
      .insert({ id: input.identityId, email: input.email, role })
      .onConflict("id")
      .ignore()
      .returning<AccountRow[]>(["id", "email", "role", "created_at"]);
    const row = rows[0];
    if (!row) throw new AccountAlreadyExistsError();
    return toAccount(row);
  }

  // Before bootstrap there is no installation row; that is not "open", because
  // the only account an installation may gain first is its admin.
  async function isRegistrationOpen(): Promise<boolean> {
    const installation = await database("installation").first<{ registration_open: boolean }>([
      "registration_open",
    ]);
    return installation?.registration_open ?? false;
  }

  return {
    async register(input) {
      if (!(await isRegistrationOpen())) throw new RegistrationClosedError();
      return record(input, "user");
    },

    async recordAdmin(input, connection) {
      return record(input, "admin", connection);
    },

    async findByEmail(email) {
      const row = await database("profiles")
        .where({ email })
        .first<AccountRow>(["id", "email", "role", "created_at"]);
      return row ? toAccount(row) : undefined;
    },

    isRegistrationOpen,
  };
}
