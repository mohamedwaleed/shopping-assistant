import { createHash, timingSafeEqual } from "node:crypto";
import type { Database } from "@shopping-assistant/database";
import { createAccounts, type Accounts, type AuthIdentityStore } from "./accounts.ts";

export {
  AccountAlreadyExistsError,
  RegistrationClosedError,
  type Account,
  type Accounts,
  type AuthIdentity,
  type AuthIdentityStore,
} from "./accounts.ts";

export type MessageRole = "user" | "assistant";

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: Date;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: Date;
}

export interface ConversationWithMessages extends Conversation {
  messages: Message[];
}

export type RequirementKind = "hard_constraint" | "preference";

export interface Requirement {
  id: string;
  kind: RequirementKind;
  statement: string;
  createdAt: Date;
}

export interface Requirements {
  hardConstraints: Requirement[];
  preferences: Requirement[];
  summary: string;
}

interface ConversationRow {
  id: string;
  title: string;
  created_at: Date;
}

interface MessageRow {
  id: string;
  role: MessageRole;
  content: string;
  created_at: Date;
}

interface RequirementRow {
  id: string;
  kind: RequirementKind;
  statement: string;
  created_at: Date;
}

/** Anything that can build a query: the database itself or an open transaction. */
type Queryable = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Raised for both unknown and other accounts' conversations so callers cannot
 * learn whether a conversation exists for someone else.
 */
export class ConversationNotFoundError extends Error {
  constructor() {
    super("Conversation not found");
    this.name = "ConversationNotFoundError";
  }
}

export interface AdminUser {
  email: string;
  role: "admin";
}

/**
 * Deliberately says nothing about the submitted value: the setup token is a
 * credential, so it must not reach responses, messages, or logs.
 */
export class SetupTokenRejectedError extends Error {
  constructor() {
    super("Setup token rejected");
    this.name = "SetupTokenRejectedError";
  }
}

/** Bootstrap is finished: the installation already has its initial admin. */
export class SetupClosedError extends Error {
  constructor() {
    super("Setup is closed because the initial admin already exists");
    this.name = "SetupClosedError";
  }
}

/**
 * Whether a capability is configured, not whether it currently answers:
 * provider-specific live diagnostics arrive with their adapters.
 */
export type Readiness = "ready" | "unconfigured";

export interface InstallationReadiness {
  database: Readiness;
  email: Readiness;
  model: Readiness;
  discovery: Readiness;
  setup: "open" | "closed";
}

/**
 * Presence-only configuration. Values are secrets or operator endpoints, so
 * they are held here and never copied into readiness results.
 */
export interface ServiceConfiguration {
  email?: { smtpUrl?: string };
  model?: { apiKey?: string; baseUrl?: string };
  discovery?: { searxngUrl?: string };
}

/** Raised when a hard constraint would be dropped without the shopper's agreement. */
export class HardConstraintRelaxationRefusedError extends Error {
  constructor() {
    super("Relaxing a hard constraint requires the shopper's agreement");
    this.name = "HardConstraintRelaxationRefusedError";
  }
}

export interface Engine {
  setup: {
    /**
     * Creates the installation's first admin, including the identity and
     * credential it signs in with. The password never leaves the call.
     */
    complete(input: { setupToken: string; email: string; password: string }): Promise<AdminUser>;
    readiness(): Promise<InstallationReadiness>;
  };
  accounts: Accounts;
  conversations: {
    create(userId: string, input: { title: string }): Promise<Conversation>;
    list(userId: string): Promise<Conversation[]>;
    appendMessage(
      userId: string,
      conversationId: string,
      input: { role: MessageRole; content: string },
    ): Promise<Message>;
    get(userId: string, conversationId: string): Promise<ConversationWithMessages>;
  };
  requirements: {
    set(
      userId: string,
      conversationId: string,
      input: { hardConstraints: { statement: string }[]; preferences: { statement: string }[] },
    ): Promise<Requirements>;
    get(userId: string, conversationId: string): Promise<Requirements>;
    revise(
      userId: string,
      conversationId: string,
      input: {
        hardConstraints?: { statement: string }[];
        preferences?: { statement: string }[];
        /** Existing hard constraints the shopper wants to stop honouring. */
        retract?: { statement: string }[];
        approvedByShopper?: true;
      },
    ): Promise<Requirements>;
  };
}

export function createEngine({
  database,
  setupToken,
  services = {},
  identity,
}: {
  database: Database;
  setupToken: string;
  services?: ServiceConfiguration;
  /** How identities are created; the web layer supplies Better Auth. */
  identity: AuthIdentityStore;
}): Engine {
  /** `INSERT ... RETURNING` yields exactly one row or throws. */
  function inserted<Row>(rows: Row[]): Row {
    const row = rows[0];
    if (!row) throw new Error("Insert returned no row");
    return row;
  }

  const toConversation = (row: ConversationRow): Conversation => ({
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
  });

  const toMessage = (row: MessageRow): Message => ({
    id: row.id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  });

  /** Compares hashes so neither length nor early mismatch reveals the token. */
  function setupTokenMatches(submitted: string): boolean {
    const digest = (value: string) => createHash("sha256").update(value).digest();
    return timingSafeEqual(digest(submitted), digest(setupToken));
  }

  const configured = (value: string | undefined): Readiness =>
    value ? "ready" : "unconfigured";

  async function isSetupOpen(): Promise<boolean> {
    return !(await database("installation").first("id"));
  }

  const toRequirement = (row: RequirementRow): Requirement => ({
    id: row.id,
    kind: row.kind,
    statement: row.statement,
    createdAt: row.created_at,
  });

  async function requireOwnedConversation(
    userId: string,
    conversationId: string,
  ): Promise<ConversationRow> {
    const row = await database("conversations")
      .where({ id: conversationId, user_id: userId })
      .first<ConversationRow>(["id", "title", "created_at"]);
    if (!row) throw new ConversationNotFoundError();
    return row;
  }

  async function record(
    conversationId: string,
    input: { hardConstraints: { statement: string }[]; preferences: { statement: string }[] },
    connection: Queryable = database,
  ): Promise<void> {
    const rows = [
      ...input.hardConstraints.map(({ statement }) => ({
        conversation_id: conversationId,
        kind: "hard_constraint",
        statement,
      })),
      ...input.preferences.map(({ statement }) => ({
        conversation_id: conversationId,
        kind: "preference",
        statement,
      })),
    ];
    if (rows.length === 0) return;
    await connection("requirements")
      .insert(rows)
      .onConflict(["conversation_id", "kind", "statement"])
      .ignore();
  }

  async function requirementsOf(conversationId: string): Promise<Requirements> {
    const rows = await database("requirements")
      .where({ conversation_id: conversationId })
      .orderBy("seq")
      .select<RequirementRow[]>(["id", "kind", "statement", "created_at"]);
    const ofKind = (kind: RequirementKind) =>
      rows.filter((row) => row.kind === kind).map(toRequirement);
    const hardConstraints = ofKind("hard_constraint");
    const preferences = ofKind("preference");
    const statements = (requirements: Requirement[]) =>
      requirements.length === 0
        ? "none"
        : requirements.map((requirement) => requirement.statement).join("; ");
    return {
      hardConstraints,
      preferences,
      summary: `Hard constraints: ${statements(hardConstraints)}. Preferences: ${statements(preferences)}.`,
    };
  }

  const accounts = createAccounts({ database });
  const identityStore = identity;

  return {
    setup: {
      async readiness() {
        return {
          // Reaching this line at all proves the connection works.
          database: "ready",
          email: configured(services.email?.smtpUrl),
          model: configured(services.model?.apiKey ?? services.model?.baseUrl),
          discovery: configured(services.discovery?.searxngUrl),
          setup: (await isSetupOpen()) ? "open" : "closed",
        };
      },

      async complete(input) {
        if (!setupTokenMatches(input.setupToken)) throw new SetupTokenRejectedError();
        // The identity is created first, while setup is still open: claiming the
        // installation is irreversible, so it must not happen until the admin
        // it names actually exists. Claiming then races on the primary key, so
        // a concurrent or replayed attempt still fails exactly once.
        await database.transaction(async (transaction) => {
          await transaction.raw("SET CONSTRAINTS ALL DEFERRED");
          // The claim is checked before any identity exists, so a replay or a
          // concurrent attempt leaves no stray account behind.
          const claimed = await transaction("installation")
            .insert({ initial_admin_created_at: transaction.fn.now() })
            .onConflict("id")
            .ignore()
            .returning<{ id: number }[]>(["id"]);
          if (!claimed[0]) throw new SetupClosedError();
          const identity = await identityStore.createUser(
            {
              email: input.email,
              name: input.email.split("@")[0] ?? input.email,
              password: input.password,
            },
            transaction,
          );
          await transaction("installation")
            .where({ id: 1 })
            .update({ initial_admin_id: identity.id });
          await accounts.recordAdmin({ identityId: identity.id, email: input.email }, transaction);
        });
        return { email: input.email, role: "admin" };
      },
    },

    accounts,

    conversations: {
      async create(userId, input) {
        const rows = await database("conversations")
          .insert({ user_id: userId, title: input.title })
          .returning<ConversationRow[]>(["id", "title", "created_at"]);
        return toConversation(inserted(rows));
      },

      async list(userId) {
        const rows = await database("conversations")
          .where({ user_id: userId })
          .orderBy([
            { column: "created_at", order: "desc" },
            { column: "id", order: "desc" },
          ])
          .select<ConversationRow[]>(["id", "title", "created_at"]);
        return rows.map(toConversation);
      },

      async appendMessage(userId, conversationId, input) {
        await requireOwnedConversation(userId, conversationId);
        const rows = await database("messages")
          .insert({
            conversation_id: conversationId,
            role: input.role,
            content: input.content,
          })
          .returning<MessageRow[]>(["id", "role", "content", "created_at"]);
        return toMessage(inserted(rows));
      },

      async get(userId, conversationId) {
        const row = await requireOwnedConversation(userId, conversationId);
        const messages = await database("messages")
          .where({ conversation_id: conversationId })
          .orderBy("seq")
          .select<MessageRow[]>(["id", "role", "content", "created_at"]);
        return {
          ...toConversation(row),
          messages: messages.map(toMessage),
        };
      },
    },
    requirements: {
      async set(userId, conversationId, input) {
        await requireOwnedConversation(userId, conversationId);
        await record(conversationId, input);
        return requirementsOf(conversationId);
      },

      async get(userId, conversationId) {
        await requireOwnedConversation(userId, conversationId);
        return requirementsOf(conversationId);
      },

      async revise(userId, conversationId, input) {
        await requireOwnedConversation(userId, conversationId);
        const retract = input.retract ?? [];
        // Only dropping a constraint the shopper already set is a relaxation;
        // adding one is not, so additions and preferences always apply. Without
        // the shopper's agreement the retraction is refused and the stricter
        // constraint stays in force.
        if (retract.length > 0 && input.approvedByShopper !== true) {
          throw new HardConstraintRelaxationRefusedError();
        }
        await database.transaction(async (transaction) => {
          if (retract.length > 0) {
            await transaction("requirements")
              .where({ conversation_id: conversationId, kind: "hard_constraint" })
              .whereIn(
                "statement",
                retract.map(({ statement }) => statement),
              )
              .del();
          }
          await record(
            conversationId,
            { hardConstraints: input.hardConstraints ?? [], preferences: input.preferences ?? [] },
            transaction,
          );
        });
        return requirementsOf(conversationId);
      },
    },
  };
}
