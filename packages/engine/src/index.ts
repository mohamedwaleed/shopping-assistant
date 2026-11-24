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

export interface Engine {
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
        approvedByShopper?: true;
      },
    ): Promise<Requirements>;
  };
}

export function createEngine({ database }: { database: Database }): Engine {
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
    await database("requirements")
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

  return {
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
        const hardConstraints = input.hardConstraints ?? [];
        // Without the shopper's own agreement a relaxation attempt is ignored,
        // so the stricter constraint stays in force rather than being traded away.
        if (hardConstraints.length > 0 && input.approvedByShopper !== true) {
          return requirementsOf(conversationId);
        }
        await record(conversationId, {
          hardConstraints,
          preferences: input.preferences ?? [],
        });
        return requirementsOf(conversationId);
      },
    },
  };
}
