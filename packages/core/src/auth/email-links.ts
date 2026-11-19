// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, randomBytes } from "node:crypto";
import type { Knex } from "knex";
import { err, ok, type Result } from "../errors";
import { isAuthorized, type Principal } from "../principal";
import type { AccountProvisioner, Authentication } from "./authentication";
import type { MailDelivery, MailMessage, MailTransport, Mailer } from "../mail/mailer";

export const INVITATION_SECONDS = 7 * 24 * 60 * 60;
export const PASSWORD_RESET_SECONDS = 30 * 60;
export const EMAIL_CHANGE_SECONDS = 30 * 60;

type Purpose = "invitation" | "password-reset" | "email-change";
type LinkRow = { id: string; identifier: string; value: string; expires_at: Date };
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normalized = (email: string) => email.trim().toLowerCase();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const identifier = (purpose: Purpose, email: string) => `${purpose}:${normalized(email)}`;

export interface PasswordRecovery {
  setPassword(input: { userId: string; newPassword: string }): Promise<void>;
}

export interface EmailLinkOperations {
  invite(principal: Principal, input: { email: string; linkBaseUrl: string }, transport: MailTransport): Promise<Result<{ delivered: true }>>;
  acceptInvitation(input: { email: string; token: string; name: string; password: string; workspaceName: string }, provisioner: AccountProvisioner): Promise<Result<{ userId: string; workspaceId: string }>>;
  requestPasswordReset(input: { email: string; linkBaseUrl: string }, transport: MailTransport): Promise<Result<{ delivered: true }>>;
  resetPassword(input: { email: string; token: string; newPassword: string }, recovery: PasswordRecovery): Promise<Result<{ changed: true; sessionsRevoked: number }>>;
  requestEmailChange(principal: Principal, input: { newEmail: string; linkBaseUrl: string }, transport: MailTransport): Promise<Result<{ delivered: true }>>;
  confirmEmailChange(input: { email: string; token: string }): Promise<Result<{ changed: true }>>;
}

export function createEmailLinkOperations(input: { db: Knex; auth: Authentication; mail: Mailer; now?: () => Date }): EmailLinkOperations {
  const now = input.now ?? (() => new Date());
  async function send(purpose: Purpose, email: string, linkBaseUrl: string, transport: MailTransport, subject: string, tokenPrefix = ""): Promise<Result<{ delivered: true }>> {
    const address = normalized(email);
    if (!emailPattern.test(address)) return err({ kind: "invalid-input", field: "email", message: "email must be a valid address" });
    const token = `${tokenPrefix}${randomBytes(32).toString("base64url")}`;
    const expiresAt = new Date(now().getTime() + (purpose === "invitation" ? INVITATION_SECONDS : PASSWORD_RESET_SECONDS) * 1000);
    const delivery = await input.mail.deliver({ to: address, subject, text: `${linkBaseUrl.replace(/\/$/, "")}?email=${encodeURIComponent(address)}&token=${encodeURIComponent(token)}` }, transport);
    if (!delivery.ok) return delivery;
    await input.db("verification").where({ identifier: identifier(purpose, address) }).delete();
    await input.db("verification").insert({ id: randomBytes(16).toString("hex"), identifier: identifier(purpose, address), value: hash(token), expires_at: expiresAt, created_at: now(), updated_at: now() });
    return ok({ delivered: true });
  }
  async function consume(purpose: Purpose, email: string, token: string): Promise<LinkRow | null> {
    const row = await input.db("verification").where({ identifier: identifier(purpose, email), value: hash(token) }).where("expires_at", ">", now()).delete().returning(["id", "identifier", "value", "expires_at"]);
    return (row[0] as LinkRow | undefined) ?? null;
  }
  return {
    async invite(principal, request, transport) {
      if (!isAuthorized(principal, "installation.manage")) return err({ kind: "forbidden", capability: "installation.manage" });
      return send("invitation", request.email, request.linkBaseUrl, transport, "Shopping Assistant invitation");
    },
    async acceptInvitation(request, provisioner) {
      const email = normalized(request.email);
      if (!request.name.trim()) return err({ kind: "invalid-input", field: "name", message: "name is required" });
      if (request.password.length < 10) return err({ kind: "invalid-input", field: "password", message: "password must be at least 10 characters" });
      const spent = await consume("invitation", email, request.token);
      if (!spent) return err({ kind: "invalid-email-link" });
      if (await input.db("user").where({ email }).first()) return err({ kind: "invalid-email-link" });
      try {
        const created = await provisioner.createCredentialAccount({ name: request.name.trim(), email, password: request.password });
        const [workspace] = await input.db("workspaces").insert({ name: request.workspaceName.trim() || "Private workspace", created_by_user_id: created.userId }).returning("id");
        await input.db("workspace_memberships").insert({ workspace_id: workspace.id, user_id: created.userId, role: "owner" });
        return ok({ userId: created.userId, workspaceId: workspace.id });
      } catch (error) { throw error; }
    },
    async requestPasswordReset(request, transport) {
      const email = normalized(request.email);
      // Do not enumerate accounts: valid and unknown addresses have the same response.
      if (!emailPattern.test(email)) return ok({ delivered: true });
      // Send the same shaped request for unknown addresses too. SMTP failures
      // therefore describe installation delivery, never whether an account
      // exists; reset completion still requires a matching stored user.
      return send("password-reset", email, request.linkBaseUrl, transport, "Reset your Shopping Assistant password");
    },
    async resetPassword(request, recovery) {
      const email = normalized(request.email);
      const spent = await consume("password-reset", email, request.token);
      if (!spent || request.newPassword.length < 10) return err({ kind: "invalid-email-link" });
      const user = await input.db("user").where({ email }).first();
      if (!user) return err({ kind: "invalid-email-link" });
      await recovery.setPassword({ userId: user.id, newPassword: request.newPassword });
      return ok({ changed: true, sessionsRevoked: await input.db("session").where({ user_id: user.id }).delete() });
    },
    async requestEmailChange(principal, request, transport) {
      const recent = await input.auth.recentAuthentication(principal);
      if (!recent.ok) return recent;
      if (!recent.value.recent) return err({ kind: "reauthentication-required" });
      const admitted = await input.auth.admission(principal);
      if (!admitted.ok) return admitted;
      return send("email-change", request.newEmail, request.linkBaseUrl, transport, "Confirm your new Shopping Assistant email address", `${admitted.value.id}.`);
    },
    async confirmEmailChange(request) {
      const email = normalized(request.email);
      const userId = request.token.split(".", 1)[0];
      if (!userId) return err({ kind: "invalid-email-link" });
      if (!await consume("email-change", email, request.token)) return err({ kind: "invalid-email-link" });
      if (await input.db("user").where({ email }).first()) return err({ kind: "invalid-email-link" });
      // The token is delivered only to the new address; changing it after its
      // atomic consumption prevents a replay from switching another identity.
      const changed = await input.db("user").where({ id: userId }).update({ email, email_verified: true, updated_at: now() });
      if (changed !== 1) return err({ kind: "invalid-email-link" });
      return ok({ changed: true });
    },
  };
}
