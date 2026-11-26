import { createHash, randomBytes } from "node:crypto";
import type { Database } from "@shopping-assistant/database";
import {
  AccountAlreadyExistsError,
  type Account,
  type Accounts,
  type AuthIdentityStore,
} from "./accounts.ts";
import { EmailUnavailableError } from "./password-reset.ts";

/** A week is long enough for a real inbox and short enough to leak little. */
export const INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;

/**
 * The emailed link is a bearer credential, so every refusal says the same
 * thing: whether a token was wrong, spent, or expired is not the redeemer's
 * business, and the message never repeats the token.
 */
export class InvitationInvalidError extends Error {
  constructor() {
    super("The invitation link is invalid, expired, or already used");
    this.name = "InvitationInvalidError";
  }
}

/** Only an admin may invite: the installation's own access policy says so. */
export class InvitationRefusedError extends Error {
  constructor() {
    super("Only an admin may invite someone");
    this.name = "InvitationRefusedError";
  }
}

export interface Invitation {
  id: string;
  /** The address the invitation was sent to, lower-cased. */
  email: string;
  createdAt: Date;
  expiresAt: Date;
  acceptedAt?: Date;
}

/** An issued invitation together with the token its link carries. */
export interface IssuedInvitation extends Invitation {
  /** Leaves this call once: it goes into the emailed link and is stored only as a digest. */
  token: string;
  /** The whole link to email, built from the public base URL. */
  url: string;
}

export interface Invitations {
  /**
   * Issues an invitation for `email` on behalf of `adminId`, and emails the
   * link. Refused unless the caller is an admin, and refused while an account
   * or a live invitation already exists for that address.
   */
  invite(adminId: string, input: { email: string }): Promise<IssuedInvitation>;
  /**
   * The invitation a link names, while it is still redeemable. For the screen
   * that asks the recipient to choose a password, which needs to show whose
   * address it is for; `undefined` covers unknown, spent, and expired alike.
   */
  find(token: string): Promise<Invitation | undefined>;
  /**
   * Creates the ordinary account an invitation names. Deliberately consults no
   * registration policy: the invitation is the authorisation, which is how an
   * installation that has closed public sign-up can still be joined.
   */
  accept(input: {
    token: string;
    name: string;
    password: string;
  }): Promise<{ account: Account; email: string }>;
}

interface InvitationRow {
  id: string;
  email: string;
  created_at: Date;
  expires_at: Date;
  accepted_at: Date | null;
}

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function toInvitation(row: InvitationRow): Invitation {
  return {
    id: row.id,
    email: row.email,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(row.accepted_at ? { acceptedAt: row.accepted_at } : {}),
  };
}

const INVITATION_COLUMNS = ["id", "email", "created_at", "expires_at", "accepted_at"] as const;

export function createInvitations({
  database,
  accounts,
  identities,
  mailer,
  baseUrl,
  now = () => new Date(),
}: {
  database: Database;
  accounts: Accounts;
  identities: AuthIdentityStore;
  /** Where the link is sent. An invitation nobody receives is not an invitation. */
  mailer?: { send(message: { to: string; subject: string; text: string }): Promise<void> };
  /** The origin shoppers reach; the emailed link is built from it. */
  baseUrl: string;
  /** The clock, so expiry can be tested without waiting. */
  now?: () => Date;
}): Invitations {
  /** `INSERT ... RETURNING` yields exactly one row or throws. */
  function inserted<Row>(rows: Row[]): Row {
    const row = rows[0];
    if (!row) throw new Error("Insert returned no row");
    return row;
  }

  return {
    async invite(adminId, input) {
      const admin = await database("profiles")
        .where({ id: adminId })
        .first<{ role: string }>("role");
      if (admin?.role !== "admin") throw new InvitationRefusedError();

      if (!mailer) throw new EmailUnavailableError();
      const email = input.email.trim().toLowerCase();
      // A second live invitation would leave two working links for one address,
      // so only an unspent one counts; an address whose invitation expired or
      // was used may be invited again.
      const pending = await database("invitations")
        .where({ email })
        .whereNull("accepted_at")
        .where("expires_at", ">", now())
        .first("id");
      if (pending) throw new AccountAlreadyExistsError();

      const token = randomBytes(32).toString("base64url");
      const issuedAt = now();
      const url = `${baseUrl}/api/auth/accept-invitation?token=${token}`;
      const rows = await database("invitations")
        .insert({
          token_hash: digest(token),
          email,
          invited_by: adminId,
          created_at: issuedAt,
          expires_at: new Date(issuedAt.getTime() + INVITATION_LIFETIME_MS),
        })
        .returning<InvitationRow[]>([...INVITATION_COLUMNS]);
      const row = inserted(rows);

      try {
        // Sent before answering: an invitation the admin was told about but the
        // recipient never received is a lie the admin cannot detect.
        await mailer.send({
          to: email,
          subject: "You have been invited to the shopping assistant",
          text: `An admin invited you to join. Open this link to choose a password and finish creating your account: ${url}`,
        });
      } catch (error) {
        // An unsent invitation would otherwise block the address from being
        // invited again until it expired.
        await database("invitations").where({ id: row.id }).del();
        throw error;
      }

      return { ...toInvitation(row), token, url };
    },

    async find(token) {
      const row = await database("invitations")
        .where({ token_hash: digest(token) })
        .whereNull("accepted_at")
        .where("expires_at", ">", now())
        .first<InvitationRow>([...INVITATION_COLUMNS]);
      return row ? toInvitation(row) : undefined;
    },

    async accept(input) {
      return database.transaction(async (transaction) => {
        // The single-use guarantee is this statement: the row is marked spent
        // in the same write that checks it was unspent, so of two simultaneous
        // redemptions exactly one returns a row and the other finds nothing.
        // Reading first and updating after would let both read "unspent".
        const claimed = await transaction("invitations")
          .where({ token_hash: digest(input.token) })
          .whereNull("accepted_at")
          .where("expires_at", ">", now())
          .update({ accepted_at: now() })
          .returning<InvitationRow[]>([...INVITATION_COLUMNS]);
        const row = claimed[0];
        if (!row) throw new InvitationInvalidError();

        // The identity store commits on its own connection, so a failure after
        // this point is undone by hand rather than by rolling the transaction
        // back underneath it.
        const identity = await identities.createUser(
          { email: row.email, name: input.name, password: input.password, invited: true },
          transaction,
        );
        try {
          // `recordInvited` rather than `register`: the invitation is the
          // authorisation, so the closed-registration gate does not apply.
          const account = await accounts.recordInvited(
            { identityId: identity.id, email: row.email },
            transaction,
          );
          await transaction("invitations")
            .where({ id: row.id })
            .update({ accepted_by: identity.id });
          return { account, email: row.email };
        } catch (error) {
          // The identity was written on its own connection, so it is undone
          // here. It has no profile, which leaves it unadministrable, so it is
          // removed outright rather than disabled.
          await database("user").where({ id: identity.id }).del();
          throw error;
        }
      });
    },
  };
}
