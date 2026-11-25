import type { Database } from "@shopping-assistant/database";
import { offeredModels } from "./policy.ts";

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
  /**
   * Ends every session an identity holds. Sessions are rows, so withdrawing an
   * account's access has to reach the ones already signed in, not only the
   * logins that would come later.
   */
  revokeSessions(identityId: string): Promise<void>;
}

export type AccountRole = "user" | "admin";

export interface Account {
  id: string;
  email: string;
  role: AccountRole;
  /** A disabled account keeps its data but cannot act on it. */
  disabled: boolean;
  createdAt: Date;
}

/** Who is asking. Resolved from a verified session in the web layer. */
export interface Actor {
  id: string;
}

interface AccountRow {
  id: string;
  email: string;
  role: AccountRole;
  disabled: boolean;
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

/**
 * Raised for every admin-only operation attempted by anyone else. It says
 * nothing about what was attempted, so a rejected caller learns nothing about
 * the installation or about other accounts.
 */
export class NotAnAdminError extends Error {
  constructor() {
    super("Administrator permission is required");
    this.name = "NotAnAdminError";
  }
}

/**
 * Raised when a change would leave the installation with no active admin. The
 * database refuses the state itself; this error is its refusal translated.
 */
export class LastAdminProtectedError extends Error {
  constructor() {
    super("The installation must keep an active admin");
    this.name = "LastAdminProtectedError";
  }
}

/**
 * Raised for both unknown accounts and accounts outside the caller's authority,
 * so an admin cannot use these operations to discover who exists.
 */
export class AccountNotFoundError extends Error {
  constructor() {
    super("Account not found");
    this.name = "AccountNotFoundError";
  }
}

/** Raised when a policy value is not one the operator allows. */
export class PolicyRefusedError extends Error {
  constructor(reason: string) {
    super(`Policy refused: ${reason}`);
    this.name = "PolicyRefusedError";
  }
}

/**
 * The administrator's installation policy. Credentials and endpoints are never
 * part of it: those are the operator's, and reach the engine as environment
 * ceilings instead.
 */
export interface InstallationPolicy {
  registrationOpen: boolean;
  /** The model an admin chose; absent while the operator's own choice stands. */
  modelId: string | undefined;
  revision: number;
  updatedAt: Date | undefined;
}

/**
 * What the operator's environment allows an admin to choose. A ceiling is a
 * restriction, so an absent ceiling allows everything the application offers
 * and a present one lists the only values an admin may pick.
 */
export interface PolicyCeilings {
  /** Model ids the deployment offers; an admin may choose among these. */
  modelIds?: string[];
  /** Whether an admin may close or reopen public registration. */
  registration?: boolean;
}

export interface PolicyChange {
  registrationOpen?: boolean;
  /** An offered model id, or `null` to leave the choice to the operator again. */
  modelId?: string | null;
}

interface PolicyRow {
  registration_open: boolean;
  policy_model_id: string | null;
  policy_revision: number;
  policy_updated_at: Date | null;
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
  /** The account behind a verified session, or `undefined` if it has none. */
  findByIdentity(identityId: string): Promise<Account | undefined>;
  isRegistrationOpen(): Promise<boolean>;
  /** Admins only: every account, including disabled ones. */
  list(actor: Actor): Promise<Account[]>;
  promote(actor: Actor, identityId: string): Promise<Account>;
  demote(actor: Actor, identityId: string): Promise<Account>;
  /**
   * Withdraws an account's access and ends its sessions. The account keeps its
   * conversations, so re-enabling it restores access to its own data only.
   */
  disable(actor: Actor, identityId: string): Promise<Account>;
  enable(actor: Actor, identityId: string): Promise<Account>;
  policy(): Promise<InstallationPolicy>;
  /** Admins only: changes policy within what the environment allows. */
  updatePolicy(actor: Actor, change: PolicyChange): Promise<InstallationPolicy>;
}

/**
 * The database is the authority on the last-active-admin rule, so the engine
 * recognises its refusal by name rather than re-deriving the rule itself.
 */
function isLastAdminRefusal(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { constraint?: unknown }).constraint === "installation_active_admin_required"
  );
}

/**
 * The role is read inside the statement that changes it, so authorization is
 * decided on the state the write actually saw rather than on an earlier read.
 */
const ACTOR_IS_ADMIN = "EXISTS (SELECT 1 FROM profiles WHERE id = ? AND role = 'admin')";

/**
 * One key for every access change in the installation. The last-active-admin
 * check is deferred to commit, and two transactions that each demote the other
 * would take row locks in opposite orders and then wait on each other's check
 * forever. Taking a transaction-scoped advisory lock before reading anything
 * means concurrent changes queue instead of deadlocking, and because it is
 * released at commit the database still decides the invariant.
 */
const ADMINISTRATION_LOCK = 5_054_001;

export function createAccounts({
  database,
  ceilings = {},
}: {
  database: Database;
  /** What the deployment allows an admin to choose. */
  ceilings?: PolicyCeilings;
}): Accounts {
  const toAccount = (row: AccountRow): Account => ({
    id: row.id,
    email: row.email,
    role: row.role,
    disabled: row.disabled,
    createdAt: row.created_at,
  });

  const accountColumns = ["id", "email", "role", "disabled", "created_at"] as const;

  async function record(
    input: { identityId: string; email: string },
    role: AccountRole,
    connection: Queryable = database,
  ): Promise<Account> {
    const rows = await connection("profiles")
      .insert({ id: input.identityId, email: input.email, role })
      .onConflict("id")
      .ignore()
      .returning<AccountRow[]>([...accountColumns]);
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

  /** Decides the caller's authority once, before any write, and writes nothing. */
  async function requireAdmin(actor: Actor): Promise<void> {
    if (!(await isAdmin(actor))) throw new NotAnAdminError();
  }

  /** Whether the caller is an active admin right now. */
  async function isAdmin(actor: Actor): Promise<boolean> {
    const admin = await database("profiles")
      .where({ id: actor.id, role: "admin", disabled: false })
      .first("id");
    return admin !== undefined;
  }

  /**
   * Admins manage access, never data: the returned rows come from the profile
   * alone, and no operation here reaches another account's conversations.
   *
   * The whole change runs in one transaction that first takes the
   * administration lock, so two admins changing each other queue up rather than
   * deadlocking on the deferred last-active-admin check.
   */
  async function changeAccount(
    actor: Actor,
    identityId: string,
    change: { role?: AccountRole; disabled?: boolean },
  ): Promise<Account> {
    await requireAdmin(actor);
    let row: AccountRow | undefined;
    try {
      row = await database.transaction(async (transaction) => {
        // Waiting is bounded so a lock held by an abandoned transaction turns
        // into a prompt refusal rather than a request that hangs forever.
        await transaction.raw("SET LOCAL lock_timeout = '10s'");
        await transaction.raw("SELECT pg_advisory_xact_lock(?)", [ADMINISTRATION_LOCK]);
        const rows = await transaction("profiles")
          .where({ id: identityId })
          .whereRaw(ACTOR_IS_ADMIN, [actor.id])
          .update(
            change.disabled === undefined
              ? change
              : {
                  ...change,
                  // A re-enabled account is not a disabled one, so the moment it
                  // was disabled stops applying.
                  disabled_at: change.disabled ? transaction.fn.now() : null,
                },
          )
          .returning<AccountRow[]>([...accountColumns]);
        const changed = rows[0];
        // Ending the sessions belongs to the same change, inside the same lock,
        // so a disabled account cannot be left signed in while a concurrent
        // change runs.
        if (changed && change.disabled === true) {
          await transaction("session").where({ userId: identityId }).del();
        }
        return changed;
      });
    } catch (error) {
      // The last-active-admin check is deferred to commit, so its refusal
      // arrives here rather than from the statement itself.
      if (isLastAdminRefusal(error)) throw new LastAdminProtectedError();
      throw error;
    }
    // No row means either the account is unknown or the caller stopped being an
    // admin while the statement ran. Both are reported as not-found, so a
    // concurrent change cannot be told apart from an unknown account.
    if (!row) {
      if (!(await isAdmin(actor))) throw new NotAnAdminError();
      throw new AccountNotFoundError();
    }
    return toAccount(row);
  }

  async function readPolicy(): Promise<InstallationPolicy> {
    const row = await database("installation").first<PolicyRow>([
      "registration_open",
      "policy_model_id",
      "policy_revision",
      "policy_updated_at",
    ]);
    // An unbootstrapped installation has no policy yet; registration is closed
    // for the same reason `isRegistrationOpen` reports it closed.
    if (!row) {
      return { registrationOpen: false, modelId: undefined, revision: 0, updatedAt: undefined };
    }
    return {
      registrationOpen: row.registration_open,
      modelId: row.policy_model_id ?? undefined,
      revision: row.policy_revision,
      updatedAt: row.policy_updated_at ?? undefined,
    };
  }

  /**
   * A ceiling restricts, so it can only ever narrow the change: an admin may
   * turn registration off, or on where the operator allows it, and may choose
   * among the offered models. With no ceiling configured the application's own
   * list is the limit, so a model id with no adapter behind it is never stored.
   */
  function withinCeilings(change: PolicyChange): void {
    if (change.registrationOpen !== undefined && ceilings.registration === false) {
      throw new PolicyRefusedError("registration policy is fixed by the deployment");
    }
    if (typeof change.modelId === "string") {
      const offered = offeredModels(ceilings.modelIds).map((model) => model.id);
      if (!offered.includes(change.modelId)) {
        throw new PolicyRefusedError("that model is not offered by the deployment");
      }
    }
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
        .first<AccountRow>([...accountColumns]);
      return row ? toAccount(row) : undefined;
    },

    async findByIdentity(identityId) {
      const row = await database("profiles")
        .where({ id: identityId })
        .first<AccountRow>([...accountColumns]);
      return row ? toAccount(row) : undefined;
    },

    isRegistrationOpen,

    async list(actor) {
      await requireAdmin(actor);
      const rows = await database("profiles")
        .orderBy("created_at")
        .select<AccountRow[]>([...accountColumns]);
      return rows.map(toAccount);
    },

    promote(actor, identityId) {
      return changeAccount(actor, identityId, { role: "admin" });
    },

    demote(actor, identityId) {
      return changeAccount(actor, identityId, { role: "user" });
    },

    async disable(actor, identityId) {
      return changeAccount(actor, identityId, { disabled: true });
    },

    enable(actor, identityId) {
      return changeAccount(actor, identityId, { disabled: false });
    },

    policy: readPolicy,

    async updatePolicy(actor, change) {
      withinCeilings(change);
      try {
        // The admin predicate is part of the write, so an admin demoted while
        // this request was in flight cannot still change the installation.
        const rows = await database("installation")
          .where({ id: 1 })
          .whereRaw(ACTOR_IS_ADMIN, [actor.id])
          .update({
            ...(change.registrationOpen === undefined
              ? {}
              : { registration_open: change.registrationOpen }),
            ...(change.modelId === undefined ? {} : { policy_model_id: change.modelId }),
            policy_revision: database.raw("policy_revision + 1"),
            policy_updated_at: database.fn.now(),
          })
          .returning<PolicyRow[]>([
            "registration_open",
            "policy_model_id",
            "policy_revision",
            "policy_updated_at",
          ]);
        const row = rows[0];
        // No row means the caller is not an admin, or has just stopped being
        // one; both are reported as a refusal rather than as a missing record.
        if (!row) throw new NotAnAdminError();
        return {
          registrationOpen: row.registration_open,
          modelId: row.policy_model_id ?? undefined,
          revision: row.policy_revision,
          updatedAt: row.policy_updated_at ?? undefined,
        };
      } catch (error) {
        // The installation row's own check runs at commit, so the refusal can
        // arrive after the update statement has already returned.
        if (isLastAdminRefusal(error)) throw new LastAdminProtectedError();
        throw error;
      }
    },
  };
}
