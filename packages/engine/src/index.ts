import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { Database } from "@shopping-assistant/database";

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

export interface Engine {
  setup: {
    complete(input: { setupToken: string; email: string }): Promise<AdminUser>;
    readiness(): Promise<InstallationReadiness>;
  };
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
}

export function createEngine({
  database,
  setupToken,
  services = {},
}: {
  database: Database;
  setupToken: string;
  services?: ServiceConfiguration;
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
        const adminId = randomUUID();
        return database.transaction(async (transaction) => {
          await transaction.raw("SET CONSTRAINTS ALL DEFERRED");
          // Claiming the single installation row is the bootstrap guard: a
          // concurrent or replayed attempt blocks on the primary key and then
          // fails, rather than checking and inserting separately.
          const claimed = await transaction("installation")
            .insert({ initial_admin_id: adminId, initial_admin_created_at: transaction.fn.now() })
            .onConflict("id")
            .ignore()
            .returning<{ id: number }[]>(["id"]);
          if (!claimed[0]) throw new SetupClosedError();
          const rows = await transaction("users")
            .insert({ id: adminId, email: input.email, role: "admin" })
            .returning<{ email: string; role: "admin" }[]>(["email", "role"]);
          return inserted(rows);
        });
      },
    },

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
  };
}
