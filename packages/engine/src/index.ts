import { createHash, timingSafeEqual } from "node:crypto";
import type { Database } from "@shopping-assistant/database";
import {
  createAccounts,
  type Accounts,
  type Actor,
  type AuthIdentityStore,
  type PolicyCeilings,
} from "./accounts.ts";
import {
  offeredModels,
  type ModelOption,
  type ModelProviderIdentity,
} from "./policy.ts";
import {
  createInvitations,
  InvitationInvalidError,
  InvitationRefusedError,
  INVITATION_LIFETIME_MS,
  type Invitation,
  type Invitations,
  type IssuedInvitation,
} from "./invitations.ts";
import {
  createPasswordResets,
  EmailUnavailableError,
  ResetTokenInvalidError,
  RESET_LIFETIME_MS,
  type PasswordResets,
  type PasswordSetter,
} from "./password-reset.ts";
import { createResearch, type Research, type ResearchCeilings } from "./research.ts";
import {
  createExtraction,
  type AddressResolver,
  type Extraction,
  type ExtractionCeilings,
} from "./extraction.ts";

export {
  AccountAlreadyExistsError,
  AccountNotFoundError,
  LastAdminProtectedError,
  NotAnAdminError,
  PolicyRefusedError,
  RegistrationClosedError,
  type Account,
  type AccountRole,
  type Accounts,
  type Actor,
  type AuthIdentity,
  type AuthIdentityStore,
  type InstallationPolicy,
  type PolicyCeilings,
  type PolicyChange,
} from "./accounts.ts";

export {
  OFFERED_MODELS,
  offeredModels,
  type ModelOption,
  type ModelProviderIdentity,
  type ModelProviderRoute,
} from "./policy.ts";
export {
  InvitationInvalidError,
  InvitationRefusedError,
  INVITATION_LIFETIME_MS,
  type Invitation,
  type Invitations,
  type IssuedInvitation,
} from "./invitations.ts";

export {
  EmailUnavailableError,
  ResetTokenInvalidError,
  RESET_LIFETIME_MS,
  type PasswordResets,
  type PasswordSetter,
} from "./password-reset.ts";

export {
  createResearch,
  DEFAULT_RESEARCH_LIMITS,
  ResearchAllowanceExhaustedError,
  ResearchRunNotFoundError,
  ResearchRunStateError,
  UsageReservationRefusedError,
  type CallPricing,
  type DailyAllowance,
  type Research,
  type ResearchCeilings,
  type ResearchLimits,
  type ResearchPauseReason,
  type ResearchPolicy,
  type ResearchRun,
  type ResearchRunState,
  type ResearchUsage,
  type UsageCallKind,
  type UsageOverview,
  type UsageReservation,
  type UsageReservationRecord,
  type UsageSettlement,
} from "./research.ts";

export {
  createExtraction,
  DEFAULT_FETCH_BOUNDS,
  ExtractionRefusedError,
  type Availability,
  type Extraction,
  type ExtractionCeilings,
  type FetchBounds,
  type FetchFailure,
  type Money,
  type OfferFacts,
  type PageClassification,
  type PageExtraction,
  type PageExtractionFailure,
  type PageExtractionSuccess,
  type PageFacts,
  type PageReason,
  type PriceRange,
  type ProductFacts,
  type UnknownFact,
} from "./extraction.ts";

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
 * One offered model as an admin sees it. `provider` is absent when the
 * deployment has no adapter behind the id, which is a fact the admin is told
 * rather than shielded from: choosing it would leave conversations with no
 * model to call.
 */
export interface ModelCatalogEntry extends ModelOption {
  provider?: ModelProviderIdentity;
}

/**
 * Presence-only configuration. Values are secrets or operator endpoints, so
 * they are held here and never copied into readiness results.
 *
 * `model` carries what the engine needs to know about the conversation model,
 * which is how each offered id is reached, never how to call it: the transport
 * lives in the agent package, so no inference SDK reaches the engine. An id the
 * operator has not wired to a provider is reported as unconfigured instead of
 * being offered as if it worked.
 */
export interface ServiceConfiguration {
  email?: { smtpUrl?: string };
  model?: {
    apiKey?: string;
    baseUrl?: string;
    /** How each offered model id is reached; absent ids have no provider. */
    providers?: Partial<Record<string, ModelProviderIdentity>>;
  };
  discovery?: { searxngUrl?: string };
}

/** Raised when a hard constraint would be dropped without the shopper's agreement. */
export class HardConstraintRelaxationRefusedError extends Error {
  constructor() {
    super("Relaxing a hard constraint requires the shopper's agreement");
    this.name = "HardConstraintRelaxationRefusedError";
  }
}

/** Emailed links need a mailer and an origin; without either nothing is sent. */
export interface AccountEmail {
  /** The origin shoppers reach; emailed links are built from it. */
  baseUrl: string;
  /** Absent when the installation has no SMTP relay; readiness then reports it. */
  mailer?: { send(message: { to: string; subject: string; text: string }): Promise<void> };
}

/**
 * An installation with no credential writer can still be asked for a reset, so
 * the request is accepted and completion then fails rather than pretending a
 * password changed.
 */
const unwritablePasswords: PasswordSetter = {
  async setPassword() {
    throw new Error("This installation cannot change a password");
  },
};

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
  /** What an administrator may choose, narrowed by the deployment. */
  administration: {
    /** The offered models after the environment ceiling is applied. */
    modelOptions(): ModelOption[];
    /**
     * Admins only: the offered models with the provider each one is reached
     * through, so a dashboard can say what an admin is choosing between. An id
     * with no provider behind it is reported as such rather than hidden: an
     * admin must be able to see that a choice would not work.
     */
    modelCatalog(actor: Actor): Promise<ModelCatalogEntry[]>;
  };
  /** Admin invitations: the one way to join an installation that has closed public sign-up. */
  invitations: Invitations;
  /** Emailed password recovery. */
  passwordResets: PasswordResets;
  /**
   * Bounded research and its usage ledger. The adapters that spend money call
   * `reserve` before each call and `settle` or `release` after it, so every
   * limit is enforced by the engine rather than by each adapter's goodwill.
   */
  research: Research;
  /**
   * Our own fetching and parsing of accessible product pages. Each retrieval
   * is charged to a research run's ledger, so a page is only read within the
   * allowance the shopper started; a login wall, a paywall, or a CAPTCHA is an
   * outcome, never something to work around.
   */
  extraction: Extraction;
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
  policyCeilings,
  researchCeilings,
  extractionCeilings,
  retrievalCostCents,
  retrieval,
  accounts: accountServices,
  now,
}: {
  database: Database;
  setupToken: string;
  services?: ServiceConfiguration;
  /** How identities are created; the web layer supplies Better Auth. */
  identity: AuthIdentityStore;
  /**
   * What the operator's environment allows an administrator to change. It
   * only ever restricts, so an installation without one offers the full set.
   */
  policyCeilings?: PolicyCeilings;
  /**
   * The most a research run may be allowed to spend or take. It only ever
   * narrows the application's own default, for the same reason policy ceilings
   * do: an admin may choose within what the deployment pays for, not beyond it.
   */
  researchCeilings?: ResearchCeilings;
  /**
   * The most page extraction may take or read. Like the other ceilings it only
   * ever narrows: a deployment can make retrieval cheaper or stricter, never
   * wider than the application's own bounds.
   */
  extractionCeilings?: ExtractionCeilings;
  /**
   * What one retrieval is estimated to cost, in cents, so page extraction is
   * bounded by the run's money as well as by its call count. Absent means the
   * deployment has no price, which the ledger records as unknown rather than
   * free.
   */
  retrievalCostCents?: number;
  /**
   * How retrieval resolves names and which addresses it may reach. A
   * deployment supplies nothing here and gets the system resolver with the
   * destination rules as they stand; the test suite supplies a resolver that
   * answers for its own fixtures, so no test reaches the internet.
   */
  retrieval?: {
    resolve?: AddressResolver;
    /** Addresses judged safe despite being private. Empty in a deployment. */
    permittedAddresses?: readonly string[];
    /** Ports a URL may name. A deployment leaves this out and 80 and 443 stand. */
    permittedPorts?: readonly number[];
  };
  /**
   * What invitations and reset links need. Omitted when the installation has
   * nowhere to send them, so readiness reports email as unconfigured and both
   * flows refuse explicitly instead of silently doing nothing.
   */
  accounts?: {
    email?: AccountEmail;
    /** How a reset writes the new credential; the engine never sees a hash. */
    passwords?: PasswordSetter;
  };
  /** The clock, so expiry can be tested without waiting. */
  now?: () => Date;
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

  const accounts = createAccounts({ database, ...(policyCeilings ? { ceilings: policyCeilings } : {}) });
  const identityStore = identity;
  const clock = now ?? (() => new Date());
  const mailer = accountServices?.email?.mailer;
  const baseUrl = accountServices?.email?.baseUrl ?? "";
  const invitations = createInvitations({
    database,
    accounts,
    identities: identityStore,
    ...(mailer ? { mailer } : {}),
    baseUrl,
    now: clock,
  });
  const passwordResets = createPasswordResets({
    database,
    identities: identityStore,
    passwords: accountServices?.passwords ?? unwritablePasswords,
    ...(mailer ? { mailer } : {}),
    baseUrl,
    now: clock,
  });
  const research = createResearch({
    database,
    ...(researchCeilings ? { ceilings: researchCeilings } : {}),
    now: clock,
  });
  const extraction = createExtraction({
    research,
    ...(extractionCeilings ? { ceilings: extractionCeilings } : {}),
    ...(retrievalCostCents === undefined ? {} : { costPerFetchCents: retrievalCostCents }),
    ...(retrieval?.resolve === undefined ? {} : { resolve: retrieval.resolve }),
    ...(retrieval?.permittedAddresses === undefined
      ? {}
      : { permittedAddresses: retrieval.permittedAddresses }),
    ...(retrieval?.permittedPorts === undefined ? {} : { permittedPorts: retrieval.permittedPorts }),
    now: clock,
  });

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
          try {
            await accounts.recordAdmin({ identityId: identity.id, email: input.email }, transaction);
          } catch (error) {
            // The identity was written on its own connection. Without this it
            // would survive as a `user` row with no profile, holding the email
            // that a retry needs, so it is removed before the claim rolls back.
            await database("user").where({ id: identity.id }).del();
            throw error;
          }
        });
        return { email: input.email, role: "admin" };
      },
    },

    accounts,

    administration: {
      modelOptions() {
        return offeredModels(policyCeilings?.modelIds);
      },

      async modelCatalog(actor) {
        // The admin check is the accounts operation's own, so an ordinary
        // account is refused before it learns anything about the deployment.
        await accounts.list(actor);
        const providers = services.model?.providers ?? {};
        return offeredModels(policyCeilings?.modelIds).map((option) => {
          const provider = providers[option.id];
          return provider ? { ...option, provider } : { ...option };
        });
      },
    },
    invitations,

    passwordResets,

    research,

    extraction,

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
