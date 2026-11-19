// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MailFailureStage } from "./mail/mailer";

export type CoreError =
  | { kind: "forbidden"; capability: string }
  | { kind: "invalid-input"; field: string; message: string }
  | { kind: "not-found"; resource: string; id: string }
  /** Setup was already claimed; the one-time token is spent. */
  | { kind: "setup-already-complete" }
  /** No setup token is held by this installation. */
  | { kind: "setup-unavailable" }
  /** The presented setup token does not match the installation-held one. */
  | { kind: "invalid-setup-token" }
  /** No invitation admits this email; public registration stays closed. */
  | { kind: "registration-closed" }
  /** Identity exists but the account cannot be used for access. */
  | { kind: "access-disabled" }
  | { kind: "invalid-credentials" }
  /** The session is valid but older than the recent-authentication window. */
  | { kind: "reauthentication-required" }
  /** Email-address changes travel through the SMTP-backed account flows. */
  | { kind: "email-change-unsupported" }
  /** The request named an origin the installation does not trust. */
  | { kind: "invalid-origin" }
  /** No complete SMTP settings, or no explicit diagnostic recipient. */
  | { kind: "mail-not-configured"; missing: "smtp" | "recipient" }
  /** The installation secret is absent or too weak to encrypt stored credentials. */
  | { kind: "installation-secret-invalid"; reason: "missing" | "too-short" }
  /** A diagnostic send is still cooling down after the previous attempt. */
  | { kind: "mail-diagnostic-cooldown"; retryAfterSeconds: number }
  /** SMTP connection, authentication or delivery failed; see the mailer contract. */
  | { kind: "mail-delivery-failed"; stage: MailFailureStage; reason: string }
  /** No model serves this role; configuration is required, no fallback exists. */
  | { kind: "model-not-configured"; role: string }
  /** The selected usage source has no stored credential for this provider. */
  | { kind: "model-credential-missing"; provider: string; source: string }
  /**
   * The stored credential belongs to another provider than the resolved model,
   * so using it would send a key to an endpoint it was never issued for.
   */
  | {
      kind: "model-credential-provider-mismatch";
      provider: string;
      credentialProvider: string;
      source: string;
    }
  /** The provider endpoint failed the bounded diagnostic request. */
  | { kind: "provider-unavailable"; message: string };

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: CoreError };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const err = (error: CoreError): Result<never> => ({ ok: false, error });
