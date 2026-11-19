// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from "node:crypto";
import type { Knex } from "knex";
import { err, ok, type Result } from "../errors";
import type { MailDelivery, Mailer, MailTransport } from "../mail/mailer";
import { isAuthorized, type Principal } from "../principal";
import type { AccountProvisioner, CredentialChanger } from "./authentication";
import { hashSetupToken } from "./setup-token";
import type {
  AcceptInvitationRequest,
  ConfirmEmailChangeRequest,
  EmailChangeConfirmationSent,
  EmailChangeConfirmed,
  InvitedShopper,
  InviteRequest,
  PasswordResetAccepted,
  PasswordResetOutcome,
  RequestPasswordResetRequest,
  ResetPasswordRequest,
} from "./account-link-types";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 10;

/** An invitation stays usable for a week; resets and confirmations for half an hour. */
export const INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
export const ACCOUNT_LINK_LIFETIME_MS = 30 * 60 * 1000;

/** Long enough that guessing is hopeless; only its hash is stored. */
const TOKEN_BYTES = 32;

type LinkKind = "invitation" | "password-reset" | "email-change";

interface LinkRow {
  id: string;
  kind: LinkKind;
  email: string;
  user_id: string | null;
  expires_at: Date;
  consumed_at: Date | null;
}

interface UserRow {
  id: string;
  name: string;
  email: string;
}

/**
 * The account-email lifecycle: invitations into a private workspace, password
 * recovery and email-address changes, all through expiring single-use links.
 * Every link is delivered over the stored SMTP settings, so a flow that cannot
 * deliver cannot claim to have happened.
 */
export interface AccountLinks {
  invite(principal: Principal, request: InviteRequest): Promise<Result<MailDelivery>>;
  acceptInvitation(
    request: AcceptInvitationRequest,
    provisioner: AccountProvisioner,
  ): Promise<Result<InvitedShopper>>;
  /**
   * Never reports whether the address has an account or whether delivery
   * worked: the caller always gets the same accepted answer.
   */
  requestPasswordReset(request: RequestPasswordResetRequest): Promise<Result<PasswordResetAccepted>>;
  resetPassword(
    request: ResetPasswordRequest,
    credentials: CredentialChanger,
  ): Promise<Result<PasswordResetOutcome>>;
  /** Ask for the change: nothing switches until the new address confirms. */
  requestEmailChange(
    principal: Principal,
    newEmail: string,
  ): Promise<Result<EmailChangeConfirmationSent>>;
  confirmEmailChange(
    request: ConfirmEmailChangeRequest,
    credentials: CredentialChanger,
  ): Promise<Result<EmailChangeConfirmed>>;
}

export interface AccountLinkDependencies {
  db: Knex;
  mail: Mailer;
  /** The installation's own transport; delivery is always a real conversation. */
  transport: MailTransport;
  /** Absolute base for links in delivered messages, for example https://host. */
  baseUrl?: () => string | undefined;
  now?: () => Date;
}

/** The message a shopper receives; it carries the link and nothing private. */
function invitationMessage(input: { name: string; link: string }): { subject: string; text: string } {
  return {
    subject: "You are invited to a Shopping Assistant workspace",
    text: [
      `Hello ${input.name},`,
      "",
      "You have been invited to a private Shopping Assistant workspace.",
      "The invitation works once and expires in seven days:",
      "",
      input.link,
      "",
      "If you were not expecting this, you can ignore this message.",
    ].join("\n"),
  };
}

function resetMessage(link: string): { subject: string; text: string } {
  return {
    subject: "Reset your Shopping Assistant password",
    text: [
      "A password reset was requested for your Shopping Assistant account.",
      "The link works once and expires in thirty minutes:",
      "",
      link,
      "",
      "If you did not ask for this, ignore this message; your password stays unchanged.",
    ].join("\n"),
  };
}

function emailChangeMessage(link: string, newEmail: string): { subject: string; text: string } {
  return {
    subject: "Confirm your new Shopping Assistant email address",
    text: [
      `A change of sign-in address to ${newEmail} was requested for your account.`,
      "The change is not active yet. Confirm it with this link, which works once and expires in thirty minutes:",
      "",
      link,
      "",
      "If you did not ask for this, ignore this message; the account keeps its current address.",
    ].join("\n"),
  };
}

export function createAccountLinks(deps: AccountLinkDependencies): AccountLinks {
  const { db, mail, transport } = deps;
  const now = deps.now ?? (() => new Date());

  function linkFor(path: string, token: string): string {
    const base = (deps.baseUrl?.() ?? "").replace(/\/+$/, "");
    return `${base}${path}?token=${token}`;
  }

  /** Mint a token; only its hash is ever written down. */
  function newToken(): { token: string; hash: string } {
    const token = randomBytes(TOKEN_BYTES).toString("base64url");
    return { token, hash: hashSetupToken(token) };
  }

  async function store(input: {
    kind: LinkKind;
    email: string;
    tokenHash: string;
    userId?: string | undefined;
    invitedByUserId?: string | undefined;
    lifetimeMs: number;
  }): Promise<void> {
    const createdAt = now();
    await db("account_link_tokens").insert({
      kind: input.kind,
      email: input.email,
      token_hash: input.tokenHash,
      user_id: input.userId ?? null,
      invited_by_user_id: input.invitedByUserId ?? null,
      expires_at: new Date(createdAt.getTime() + input.lifetimeMs),
      created_at: createdAt,
    });
  }

  /**
   * Read a link without spending it, so a flow can do its own work first and
   * only then consume the token. Reading alone never authorizes anything.
   */
  async function claimLink(input: { token: string; kind: LinkKind }): Promise<LinkRow | null> {
    const presented = input.token.trim();
    if (!presented) return null;
    const row = await db("account_link_tokens")
      .where({ token_hash: hashSetupToken(presented), kind: input.kind })
      .whereNull("consumed_at")
      .andWhere("expires_at", ">", now())
      .first();
    return (row as LinkRow | undefined) ?? null;
  }

  /**
   * Spend a link in one conditional update: the row must still be unconsumed
   * and unexpired, so of any number of concurrent consumers exactly one sees
   * the updated row and every other one loses. Nothing about which of those
   * two conditions failed is reported.
   */
  async function consume(input: {
    token: string;
    kind: LinkKind;
    userId?: string | undefined;
  }): Promise<LinkRow | null> {
    const presented = input.token.trim();
    if (!presented) return null;
    const at = now();
    const [row] = await db("account_link_tokens")
      .where({ token_hash: hashSetupToken(presented), kind: input.kind })
      .whereNull("consumed_at")
      .andWhere("expires_at", ">", at)
      .modify((query) => {
        if (input.userId) query.where({ user_id: input.userId });
      })
      .update({ consumed_at: at })
      .returning(["id", "kind", "email", "user_id", "expires_at", "consumed_at"]);
    return (row as LinkRow | undefined) ?? null;
  }

  async function invite(
    principal: Principal,
    request: InviteRequest,
  ): Promise<Result<MailDelivery>> {
    if (principal.kind === "anonymous" || !isAuthorized(principal, "installation.manage")) {
      return err({ kind: "forbidden", capability: "installation.manage" });
    }
    const email = request.email.trim().toLowerCase();
    const name = request.name.trim();
    if (!EMAIL_PATTERN.test(email)) {
      return err({ kind: "invalid-input", field: "email", message: "email must be a valid address" });
    }
    if (!name) {
      return err({ kind: "invalid-input", field: "name", message: "name is required" });
    }
    if (await db("user").where({ email }).first()) {
      return err({ kind: "invalid-input", field: "email", message: "email is already in use" });
    }

    const { token, hash } = newToken();
    const message = invitationMessage({ name, link: linkFor("/invitations/accept", token) });
    const delivered = await mail.send(transport, { to: email, ...message });
    // Nothing usable survives a failed delivery: the link was never sent, so
    // an operator can simply invite again once email works.
    if (!delivered.ok) return delivered;

    // A newer invitation replaces the older one for that address, so an
    // invitation that leaked stops working the moment it is reissued. This
    // runs only after delivery, so a failed send cannot retire the link the
    // shopper already holds.
    const at = now();
    await db("account_link_tokens")
      .where({ kind: "invitation", email })
      .whereNull("consumed_at")
      .update({ consumed_at: at });
    await store({
      kind: "invitation",
      email,
      tokenHash: hash,
      invitedByUserId: principal.userId,
      lifetimeMs: INVITATION_LIFETIME_MS,
    });
    return delivered;
  }

  async function acceptInvitation(
    request: AcceptInvitationRequest,
    provisioner: AccountProvisioner,
  ): Promise<Result<InvitedShopper>> {
    const name = request.name.trim();
    if (!name) {
      return err({ kind: "invalid-input", field: "name", message: "name is required" });
    }
    if (request.password.length < MIN_PASSWORD_LENGTH) {
      return err({
        kind: "invalid-input",
        field: "password",
        message: `password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      });
    }

    // The token names the address, so the account is created for the invited
    // mailbox and never for whatever the browser typed.
    const link = await claimLink({ token: request.token, kind: "invitation" });
    if (!link) return err({ kind: "invalid-account-link" });
    if (await db("user").where({ email: link.email }).first()) {
      return err({ kind: "invalid-account-link" });
    }

    let userId: string;
    try {
      const created = await provisioner.createCredentialAccount({
        name,
        email: link.email,
        password: request.password,
      });
      userId = created.userId;
    } catch {
      // A refused identity (for example a duplicate created concurrently) must
      // not leave the invitation spent, or the shopper could never accept it.
      await db("account_link_tokens").where({ id: link.id }).update({ consumed_at: null });
      return err({ kind: "invalid-account-link" });
    }

    // Spend the link only once the account exists, so a failure below can
    // release it and the shopper can retry with the same message.
    const spent = await consume({ token: request.token, kind: "invitation" });
    if (!spent) return err({ kind: "invalid-account-link" });

    const user = (await db("user").where({ id: userId }).first()) as UserRow;
    // Each shopper owns exactly one private workspace; nothing of the inviter
    // or of any other shopper is reachable from it.
    const [workspace] = await db("workspaces")
      .insert({ name: `${user.name}'s workspace`, created_by_user_id: user.id })
      .returning("id");
    await db("workspace_memberships").insert({
      workspace_id: workspace.id,
      user_id: user.id,
      role: "owner",
    });
    await db("account_link_tokens").where({ id: link.id }).update({ user_id: user.id });

    return ok({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        workspace: { workspaceId: workspace.id, role: "owner" },
      },
    });
  }

  async function requestPasswordReset(
    request: RequestPasswordResetRequest,
  ): Promise<Result<PasswordResetAccepted>> {
    // The caller is told the same thing whatever happens below: a different
    // answer for an unknown address, or for a delivery that failed, would
    // turn this endpoint into an account directory.
    const accepted = ok<PasswordResetAccepted>({ accepted: true });
    const email = request.email.trim().toLowerCase();
    if (!EMAIL_PATTERN.test(email)) return accepted;

    const user = (await db("user").where({ email }).first()) as UserRow | undefined;
    if (!user) return accepted;

    const { token, hash } = newToken();
    const delivered = await mail.send(transport, {
      to: email,
      ...resetMessage(linkFor("/reset-password", token)),
    });
    if (!delivered.ok) return accepted;

    // Older reset links for the account stop working, so only the newest one
    // in the mailbox can be spent.
    const at = now();
    await db("account_link_tokens")
      .where({ kind: "password-reset", user_id: user.id })
      .whereNull("consumed_at")
      .update({ consumed_at: at });
    await store({
      kind: "password-reset",
      email,
      tokenHash: hash,
      userId: user.id,
      lifetimeMs: ACCOUNT_LINK_LIFETIME_MS,
    });
    return accepted;
  }

  async function resetPassword(
    request: ResetPasswordRequest,
    credentials: CredentialChanger,
  ): Promise<Result<PasswordResetOutcome>> {
    if (request.newPassword.length < MIN_PASSWORD_LENGTH) {
      return err({
        kind: "invalid-input",
        field: "newPassword",
        message: `password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      });
    }
    const link = await consume({ token: request.token, kind: "password-reset" });
    if (!link?.user_id) return err({ kind: "invalid-account-link" });

    // Whoever can read the mailbox takes the account over completely, so every
    // existing session goes first: an attacker already signed in is signed out
    // even if the password write fails afterwards.
    const sessionsRevoked = await db("session").where({ user_id: link.user_id }).delete();
    try {
      await credentials.setPassword({ userId: link.user_id, newPassword: request.newPassword });
    } catch {
      return err({ kind: "invalid-credentials" });
    }
    return ok({ reset: true, sessionsRevoked });
  }

  async function requestEmailChange(
    principal: Principal,
    newEmailInput: string,
  ): Promise<Result<EmailChangeConfirmationSent>> {
    if (principal.kind === "anonymous") {
      return err({ kind: "forbidden", capability: "workspace.read" });
    }
    const newEmail = newEmailInput.trim().toLowerCase();
    if (!EMAIL_PATTERN.test(newEmail)) {
      return err({ kind: "invalid-input", field: "newEmail", message: "newEmail must be a valid address" });
    }
    const user = (await db("user").where({ id: principal.userId }).first()) as UserRow | undefined;
    if (!user) return err({ kind: "not-found", resource: "user", id: principal.userId });
    if (user.email.toLowerCase() === newEmail) {
      return err({ kind: "invalid-input", field: "newEmail", message: "email is unchanged" });
    }
    // Another account's address is refused rather than confirmed: the mailbox
    // owner would otherwise be asked to hand their identity to a second user.
    if (await db("user").where({ email: newEmail }).first()) {
      return err({ kind: "invalid-input", field: "newEmail", message: "email is already in use" });
    }

    const { token, hash } = newToken();
    const delivered = await mail.send(transport, {
      to: newEmail,
      ...emailChangeMessage(linkFor("/email-change/confirm", token), newEmail),
    });
    // Unavailable email means no confirmation exists, so the caller is told
    // the truth instead of a change that will never complete.
    if (!delivered.ok) return delivered;

    const at = now();
    await db("account_link_tokens")
      .where({ kind: "email-change", user_id: user.id })
      .whereNull("consumed_at")
      .update({ consumed_at: at });
    await store({
      kind: "email-change",
      email: newEmail,
      tokenHash: hash,
      userId: user.id,
      lifetimeMs: ACCOUNT_LINK_LIFETIME_MS,
    });
    return ok({ confirmationSent: true });
  }

  async function confirmEmailChange(
    request: ConfirmEmailChangeRequest,
    credentials: CredentialChanger,
  ): Promise<Result<EmailChangeConfirmed>> {
    const link = await consume({ token: request.token, kind: "email-change" });
    if (!link?.user_id) return err({ kind: "invalid-account-link" });
    const user = (await db("user").where({ id: link.user_id }).first()) as UserRow | undefined;
    if (!user) return err({ kind: "invalid-account-link" });

    // The address may have been taken between the request and the confirmation.
    const taken = await db("user").where({ email: link.email }).whereNot({ id: user.id }).first();
    if (taken) {
      return err({ kind: "invalid-input", field: "newEmail", message: "email is already in use" });
    }

    try {
      await credentials.changeEmail({ userId: user.id, newEmail: link.email });
    } catch {
      return err({ kind: "invalid-account-link" });
    }
    // The account now signs in as the new address, so every session issued
    // under the old identity ends and the shopper signs in again.
    await db("session").where({ user_id: user.id }).delete();
    return ok({ confirmed: true, email: link.email });
  }

  return {
    invite,
    acceptInvitation,
    requestPasswordReset,
    resetPassword,
    requestEmailChange,
    confirmEmailChange,
  };
}
