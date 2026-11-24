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
