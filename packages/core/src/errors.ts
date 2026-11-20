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
  /** A password is correct but this account still needs its authenticator or recovery code. */
  | { kind: "second-factor-required" }
  /** An authenticator or recovery code was incorrect, expired, or already used. */
  | { kind: "invalid-second-factor" }
  /** The session is valid but older than the recent-authentication window. */
  | { kind: "reauthentication-required" }
  /** Email-address changes travel through the SMTP-backed account flows. */
  | { kind: "email-change-unsupported" }
  /** An invitation, reset or email-confirmation link is invalid, expired or spent. */
  | { kind: "invalid-email-link" }
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
  | { kind: "provider-unavailable"; message: string }
  /** Provider work is visibly paused until its allowance or slot is available. */
  | { kind: "budget-paused"; reason: "allowance" | "concurrency"; budgetKind: string }
  /** A workspace key cannot be spent by scheduled work without consent. */
  | { kind: "background-personal-key-consent-required" }
  | { kind: "budget-retry-exhausted"; budgetKind: string }
  /** The URL has an unsafe scheme, credential, host or network destination. */
  | { kind: "unsafe-url"; message: string }
  /** No explicitly configured source policy permits this URL. */
  | { kind: "source-not-permitted"; url: string }
  /**
   * Retrieval was refused or unusable: a blocked/challenged page, an unsafe or
   * disallowed redirect, a non-success status, a body over the size bound, a
   * request that outlived its timeout, or a network failure. Nothing was
   * persisted from it.
   */
  | {
      kind: "source-fetch-failed";
      classification: "redirect" | "challenge" | "http" | "network" | "size" | "timeout";
      /** The submitted URL, so a failure stays attributable. */
      sourceUrl?: string;
      /** The URL being retrieved when the refusal happened. */
      url?: string;
      /** HTTP status when a response arrived at all. */
      status?: number;
    }
  /** The page did not contain a complete supported structured product offer. */
  | { kind: "extraction-failed"; message: string }
  /**
   * Existing identifier evidence names a different configuration. The fields
   * that disagree are listed so the ambiguity is inspectable; nothing is merged.
   */
  | { kind: "identity-conflict"; identifier: string; conflicting?: readonly string[] }
  /** No ChatGPT plan connection exists for this workspace. */
  | { kind: "chatgpt-plan-not-connected" }
  /** The connection was disconnected, or its refresh token is unusable. */
  | { kind: "chatgpt-plan-disconnected" }
  /** The provider withheld the plan scope; plan usage stays disabled. */
  | { kind: "chatgpt-plan-not-enabled" }
  /** The access token expired and no refresh was recorded yet. */
  | { kind: "chatgpt-plan-expired" }
  /**
   * The plan cannot pay for this request right now. Inference pauses visibly;
   * there is no silent fallback to an API key.
   */
  | { kind: "chatgpt-plan-usage-limit"; reason: "usage-limit" | "not-eligible" | "usage-unavailable" | "unsupported-capability" }
  /** The account's model list must be discovered before a model is chosen. */
  | { kind: "chatgpt-plan-model-not-selected" }
  /** The requested model is not in this account's own list. */
  | { kind: "chatgpt-plan-model-unavailable"; modelId: string; available: string[] }
  /** The shopper declined the provider consent screen. */
  | { kind: "chatgpt-plan-consent-declined" }
  /** A provider Responses call failed with the provider's own error code. */
  | { kind: "chatgpt-plan-request-failed"; code: string | null; status: number };
;

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: CoreError };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const err = (error: CoreError): Result<never> => ({ ok: false, error });
