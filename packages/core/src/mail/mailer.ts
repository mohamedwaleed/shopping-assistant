// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Knex } from "knex";
import { err, ok, type Result } from "../errors";
import {
  INSTALLATION_SECRET_ENV,
  MINIMUM_INSTALLATION_SECRET_LENGTH,
} from "../installation-secret";
import { isAuthorized, type Principal } from "../principal";
import { openSecret, sealSecret } from "./sealed-secret";


/** Cooldown between diagnostic sends, so an administrator session cannot spam SMTP. */
export const DIAGNOSTIC_COOLDOWN_MS = 30_000;

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
  /** The installation secret is absent or too weak to encrypt stored credentials. */
  | { kind: "installation-secret-invalid"; reason: "missing" | "too-short" }
  /** A diagnostic send is still cooling down after the previous attempt. */
  | { kind: "mail-diagnostic-cooldown"; retryAfterSeconds: number }
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
  /**
   * Deliver one transactional message through the stored SMTP settings. The
   * caller has already decided who may receive it (an invitation, a reset
   * link); this only decrypts the stored credentials, sends and reports the
   * same outcome contract as the diagnostic. Delivery failures are recorded
   * on the installation so an administrator sees that email is failing.
   */
  send(transport: MailTransport, message: MailMessage): Promise<Result<MailDelivery>>;
}

export interface MailerDependencies {
  db: Knex;
  /** Installation secret held outside the database; defaults to the environment. */
  installationSecret?: string | undefined;
  now?: () => Date;
  /** Extra secret values to strip from a reported failure reason. */
  redactions?: ReadonlyArray<string>;
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
 * wrong host is distinguishable from a wrong password. A server rejection
 * carries the reply in `responseCode` (535 rejected the credentials, 550 the
 * mailbox), while transport failures carry a nodemailer `E*` code.
 */
export function failureStageFromCode(
  code: string | undefined,
  responseCode?: number,
): MailFailureStage {
  if (responseCode === 535) return "authentication";
  if (code === "EAUTH" || code === "ELOGIN" || code === "ENOAUTH") return "authentication";
  if (code === "EENVELOPE" || code === "EMESSAGE" || code === "EMAXRECIPIENTS") return "delivery";
  if (code?.startsWith("E") && !/^E?\d/.test(code)) return "connection";
  return "delivery";
}

export function createMailer(deps: MailerDependencies): Mailer {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  /**
   * The installation secret held outside the database. A short value would
   * derive a guessable key, so it fails closed instead of storing anything.
   */
  function installationSecret(): Result<string> {
    const secret = (deps.installationSecret ?? process.env[INSTALLATION_SECRET_ENV])?.trim();
    if (!secret) return err({ kind: "installation-secret-invalid", reason: "missing" });
    if (secret.length < MINIMUM_INSTALLATION_SECRET_LENGTH) {
      return err({ kind: "installation-secret-invalid", reason: "too-short" });
    }
    return ok(secret);
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
      if (!secret.ok) return secret;
      passwordCiphertext = sealSecret(password, secret.value);
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

    // A diagnostic send is a deliberate, rate-limited action: the last attempt
    // is persisted, so a second send has to wait for the cooldown to pass.
    const attemptedAt = now();
    const previousAttempt = row.mail_delivery
      ? Date.parse(row.mail_delivery.attemptedAt)
      : Number.NaN;
    if (Number.isFinite(previousAttempt)) {
      // The stored attempt can sit in the future when the clock moved backwards;
      // waiting out the whole cooldown is the safe reading of that.
      const remaining = Math.min(
        previousAttempt + DIAGNOSTIC_COOLDOWN_MS - attemptedAt.getTime(),
        DIAGNOSTIC_COOLDOWN_MS,
      );
      if (remaining > 0) {
        return err({
          kind: "mail-diagnostic-cooldown",
          retryAfterSeconds: Math.ceil(remaining / 1000),
        });
      }
    }

    return deliver(
      transport,
      stored,
      {
        to: stored.recipient,
        subject: "Shopping Assistant diagnostic message",
        text: [
          "This is a diagnostic message from your Shopping Assistant installation.",
          "",
          "If you received it, transactional email delivery works. No shopper data is included.",
        ].join("\n"),
      },
      attemptedAt,
    );
  }

  /**
   * One delivery through the stored settings, recording the outcome. The
   * stored password is decrypted here and never leaves this function, and a
   * reported reason is redacted before it can reach a log or a response.
   */
  async function deliver(
    transport: MailTransport,
    stored: StoredSettings,
    message: MailMessage,
    attemptedAt: Date,
  ): Promise<Result<MailDelivery>> {
    const secret = installationSecret();
    if (!secret.ok) return secret;

    let password: string;
    try {
      password = openSecret(stored.passwordCiphertext, secret.value);
    } catch {
      return err({
        kind: "mail-delivery-failed",
        stage: "authentication",
        reason: "the stored SMTP password could not be decrypted with the installation secret",
      });
    }

    const attemptedIso = attemptedAt.toISOString();
    const recipient = message.to;
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
        message,
      );
      const delivered: MailDeliveryView = {
        outcome: "delivered",
        recipient,
        attemptedAt: attemptedIso,
        stage: null,
        reason: null,
      };
      await db("installation").where({ id: 1 }).update({
        mail_delivery: delivered,
        updated_at: now(),
      });
      return ok({ ...delivery, recipient, deliveredAt: attemptedIso });
    } catch (error) {
      const failure = error as { code?: string; message?: string; responseCode?: number };
      const stage = failureStageFromCode(failure.code, failure.responseCode);
      // Servers echo what they were sent, so the username and host are secrets too.
      const reason = redact(
        [failure.message, failure.code].filter(Boolean).join(" | ") || String(error),
        [password, stored.username, stored.host, ...(deps.redactions ?? [])],
      );
      await db("installation").where({ id: 1 }).update({
        mail_delivery: {
          outcome: "failed",
          recipient,
          attemptedAt: attemptedIso,
          stage,
          reason,
        } satisfies MailDeliveryView,
        updated_at: now(),
      });
      return err({ kind: "mail-delivery-failed", stage, reason });
    }
  }

  async function send(
    transport: MailTransport,
    message: MailMessage,
  ): Promise<Result<MailDelivery>> {
    const row = await installation();
    const stored = row.smtp_settings;
    if (!stored) return err({ kind: "mail-not-configured", missing: "smtp" });
    const recipient = message.to.trim().toLowerCase();
    if (!EMAIL_PATTERN.test(recipient)) {
      return err({ kind: "invalid-input", field: "to", message: "to must be a valid address" });
    }
    return deliver(transport, stored, { ...message, to: recipient }, now());
  }

  return { settings, saveSettings, sendDiagnostic, send };
}
