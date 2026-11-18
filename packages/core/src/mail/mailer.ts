// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Knex } from "knex";
import { err, ok, type Result } from "../errors";
import { isAuthorized, type Principal } from "../principal";
import { openSecret, sealSecret } from "./sealed-secret";

/** Environment variable carrying the installation secret used for encryption. */
export const INSTALLATION_SECRET_ENV = "INSTALLATION_SECRET";
/** Name of the installation administrator's session cookie. */
export const ADMINISTRATOR_SESSION_COOKIE = "better-auth.session_token";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Reusable mailer outcome contract. Email flows in later tickets (invitations,
 * password recovery, address change, alerts) report through these same shapes
 * and send through the same transport seam, so every caller distinguishes
 * "not configured" from "could not connect", "could not authenticate" and
 * "delivery failed" without inventing its own error vocabulary.
 */
export type MailFailureStage = "connection" | "authentication" | "delivery";

export type MailError =
  /** No complete SMTP settings, or no explicit diagnostic recipient. */
  | { kind: "mail-not-configured"; missing: "smtp" | "recipient" }
  | { kind: "mail-delivery-failed"; stage: MailFailureStage; reason: string };

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface MailDelivery {
  delivered: true;
  recipient: string;
  messageId: string;
  /** ISO timestamp of the accepted delivery. */
  deliveredAt: string;
}

/**
 * Transport seam. The nodemailer implementation lives in this package; a
 * caller may pass another adapter, but delivery is always a real SMTP
 * conversation rather than a mocked success.
 */
export interface MailTransport {
  deliver(settings: SmtpConnection, message: MailMessage): Promise<MailDelivery>;
}

/** Connection values handed to a transport; the password never leaves core. */
export interface SmtpConnection {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  fromAddress: string;
  fromName: string;
}

/** Stored SMTP settings as read back by an administrator: never the password. */
export interface SmtpSettingsView {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  fromAddress: string;
  fromName: string;
  passwordSet: boolean;
}

export interface MailDeliveryView {
  outcome: "delivered" | "failed";
  recipient: string;
  /** ISO timestamp of the attempt. */
  attemptedAt: string;
  stage: MailFailureStage | null;
  reason: string | null;
}

export interface MailSettingsView {
  configured: boolean;
  smtp: SmtpSettingsView | null;
  /** Explicit diagnostic recipient; never inferred from an account. */
  recipient: string | null;
  /** Most recent failure, or null once a delivery succeeds. */
  failure: { stage: MailFailureStage; reason: string; attemptedAt: string } | null;
  lastDelivery: MailDeliveryView | null;
}

export interface SmtpSettingsInput {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  /** Omitted to keep the stored password (for example when only the sender changed). */
  password?: string | undefined;
  fromAddress: string;
  fromName: string;
  /**
   * Explicit address the diagnostic message goes to. It is never inferred from
   * an administrator's account, so a diagnostic send stays refused until the
   * operator names a mailbox (for example a local test inbox).
   */
  recipient?: string | undefined;
}

export interface Mailer {
  settings(principal: Principal): Promise<Result<MailSettingsView>>;
  saveSettings(
    principal: Principal,
    input: SmtpSettingsInput,
  ): Promise<Result<MailSettingsView>>;
  /** Deliberate, administrator-triggered diagnostic delivery. */
  sendDiagnostic(
    principal: Principal,
    transport: MailTransport,
  ): Promise<Result<MailDelivery>>;
}

export interface MailerDependencies {
  db: Knex;
  /** Installation secret held outside the database; defaults to the environment. */
  installationSecret?: string | undefined;
  now?: () => Date;
  /** Extra secret values to strip from a reported failure reason. */
  redactions?: ReadonlyArray<string>;
}

/** Why email-dependent flows are unavailable, for settings screens. */
export function mailStatus(view: MailSettingsView): "ready" | "unconfigured" | "failing" {
  if (!view.configured) return "unconfigured";
  return view.failure ? "failing" : "ready";
}

interface StoredSettings {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  passwordCiphertext: string;
  fromAddress: string;
  fromName: string;
  recipient: string | null;
}

interface InstallationRow {
  smtp_settings: StoredSettings | null;
  mail_delivery: MailDeliveryView | null;
}

const MAX_REASON_LENGTH = 200;

/**
 * Nodemailer reports the SMTP phase that failed; map it onto the contract so a
 * wrong host is distinguishable from a wrong password.
 */
export function failureStageFromCode(code: string | undefined): MailFailureStage {
  if (!code) return "delivery";
  if (code === "EAUTH" || code === "ELOGIN") return "authentication";
  if (code.startsWith("E") && !/^E?\d/.test(code)) return "connection";
  return "delivery";
}

export function createMailer(deps: MailerDependencies): Mailer {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  function installationSecret(): string | null {
    const secret = deps.installationSecret ?? process.env[INSTALLATION_SECRET_ENV];
    return secret && secret.trim() ? secret : null;
  }

  /** Strip known secrets before a reason can reach a log, screen or model. */
  function redact(text: string, secrets: ReadonlyArray<string>): string {
    let redacted = text;
    for (const value of secrets) {
      if (value) redacted = redacted.split(value).join("[redacted]");
    }
    return redacted.slice(0, MAX_REASON_LENGTH);
  }

  async function installation(): Promise<InstallationRow> {
    const row = await db("installation")
      .where({ id: 1 })
      .select("smtp_settings", "mail_delivery")
      .first();
    if (!row) throw new Error("installation row is missing; run migrations");
    return row as InstallationRow;
  }

  function view(stored: StoredSettings | null, delivery: MailDeliveryView | null): MailSettingsView {
    return {
      configured: stored !== null,
      smtp: stored
        ? {
            host: stored.host,
            port: stored.port,
            secure: stored.secure,
            username: stored.username,
            fromAddress: stored.fromAddress,
            fromName: stored.fromName,
            passwordSet: stored.passwordCiphertext.length > 0,
          }
        : null,
      recipient: stored?.recipient ?? null,
      failure:
        delivery && delivery.outcome === "failed" && delivery.stage
          ? {
              stage: delivery.stage,
              reason: delivery.reason ?? "",
              attemptedAt: delivery.attemptedAt,
            }
          : null,
      lastDelivery: delivery,
    };
  }

  function requireAdministrator(principal: Principal): Result<true> {
    if (!isAuthorized(principal, "installation.manage")) {
      return err({ kind: "forbidden", capability: "installation.manage" });
    }
    return ok(true);
  }

  async function settings(principal: Principal): Promise<Result<MailSettingsView>> {
    const allowed = requireAdministrator(principal);
    if (!allowed.ok) return allowed;
    const row = await installation();
    return ok(view(row.smtp_settings, row.mail_delivery));
  }

  async function saveSettings(
    principal: Principal,
    input: SmtpSettingsInput,
  ): Promise<Result<MailSettingsView>> {
    const allowed = requireAdministrator(principal);
    if (!allowed.ok) return allowed;

    const host = input.host.trim();
    const username = input.username.trim();
    const fromAddress = input.fromAddress.trim().toLowerCase();
    const fromName = input.fromName.trim();
    const recipient = (input.recipient ?? "").trim().toLowerCase();
    if (!host) {
      return err({ kind: "invalid-input", field: "host", message: "host is required" });
    }
    if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
      return err({ kind: "invalid-input", field: "port", message: "port must be 1-65535" });
    }
    if (!EMAIL_PATTERN.test(fromAddress)) {
      return err({
        kind: "invalid-input",
        field: "fromAddress",
        message: "fromAddress must be a valid address",
      });
    }
    if (recipient && !EMAIL_PATTERN.test(recipient)) {
      return err({
        kind: "invalid-input",
        field: "recipient",
        message: "recipient must be a valid address",
      });
    }

    const row = await installation();
    const previous = row.smtp_settings;
    const password = input.password ?? "";
    let passwordCiphertext: string;
    if (password) {
      const secret = installationSecret();
      if (!secret) {
        return err({
          kind: "invalid-input",
          field: "password",
          message: `${INSTALLATION_SECRET_ENV} must be set to store an SMTP password`,
        });
      }
      passwordCiphertext = sealSecret(password, secret);
    } else if (previous) {
      passwordCiphertext = previous.passwordCiphertext;
    } else {
      return err({
        kind: "invalid-input",
        field: "password",
        message: "password is required",
      });
    }

    const stored: StoredSettings = {
      host,
      port: input.port,
      secure: input.secure,
      username,
      passwordCiphertext,
      fromAddress,
      fromName: fromName || fromAddress,
      recipient: recipient || null,
    };
    await db("installation").where({ id: 1 }).update({
      smtp_settings: stored,
      updated_at: now(),
    });
    return ok(view(stored, row.mail_delivery));
  }

  async function sendDiagnostic(
    principal: Principal,
    transport: MailTransport,
  ): Promise<Result<MailDelivery>> {
    const allowed = requireAdministrator(principal);
    if (!allowed.ok) return allowed;

    const row = await installation();
    const stored = row.smtp_settings;
    if (!stored) return err({ kind: "mail-not-configured", missing: "smtp" });
    if (!stored.recipient) return err({ kind: "mail-not-configured", missing: "recipient" });
    const secret = installationSecret();
    if (!secret) {
      return err({
        kind: "mail-delivery-failed",
        stage: "authentication",
        reason: `${INSTALLATION_SECRET_ENV} is not set, so the stored SMTP password cannot be read`,
      });
    }

    let password: string;
    try {
      password = openSecret(stored.passwordCiphertext, secret);
    } catch {
      return err({
        kind: "mail-delivery-failed",
        stage: "authentication",
        reason: "the stored SMTP password could not be decrypted with the installation secret",
      });
    }

    const attemptedAt = now().toISOString();
    const recipient = stored.recipient;
    try {
      const delivery = await transport.deliver(
        {
          host: stored.host,
          port: stored.port,
          secure: stored.secure,
          username: stored.username,
          password,
          fromAddress: stored.fromAddress,
          fromName: stored.fromName,
        },
        {
          to: recipient,
          subject: "Shopping Assistant diagnostic message",
          text: [
            "This is a diagnostic message from your Shopping Assistant installation.",
            "",
            "If you received it, transactional email delivery works. No shopper data is included.",
          ].join("\n"),
        },
      );
      const delivered: MailDeliveryView = {
        outcome: "delivered",
        recipient,
        attemptedAt,
        stage: null,
        reason: null,
      };
      await db("installation").where({ id: 1 }).update({
        mail_delivery: delivered,
        updated_at: now(),
      });
      return ok({ ...delivery, recipient, deliveredAt: attemptedAt });
    } catch (error) {
      const failure = error as { code?: string; message?: string };
      const stage = failureStageFromCode(failure.code);
      const reason = redact(
        [failure.message, failure.code].filter(Boolean).join(" | ") || String(error),
        [password, ...(deps.redactions ?? [])],
      );
      await db("installation").where({ id: 1 }).update({
        mail_delivery: {
          outcome: "failed",
          recipient,
          attemptedAt,
          stage,
          reason,
        } satisfies MailDeliveryView,
        updated_at: now(),
      });
      return err({ kind: "mail-delivery-failed", stage, reason });
    }
  }

  return { settings, saveSettings, sendDiagnostic };
}
