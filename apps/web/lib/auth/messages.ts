// SPDX-License-Identifier: AGPL-3.0-or-later
import type { CoreError, MailFailureStage } from "@shopping/core";
import type { Dictionary } from "@/lib/i18n";

/** User-facing message for a core error; setup and sign-in screens only. */
export function authErrorMessage(error: CoreError, t: Dictionary): string {
  switch (error.kind) {
    case "invalid-setup-token":
      return t.errorInvalidSetupToken;
    case "setup-already-complete":
      return t.errorSetupAlreadyComplete;
    case "setup-unavailable":
      return t.errorSetupUnavailable;
    case "invalid-credentials":
      return t.errorInvalidCredentials;
    case "registration-closed":
      return t.errorRegistrationClosed;
    case "invalid-input":
      return t.errorInvalidInput;
    default:
      return t.errorGeneric;
  }
}

/** User-facing message for a core error on the account screens. */
export function accountErrorMessage(error: CoreError, t: Dictionary): string {
  switch (error.kind) {
    case "reauthentication-required":
      return t.errorReauthenticationRequired;
    case "invalid-credentials":
      return t.errorInvalidCredentials;
    case "email-change-unsupported":
      return t.errorEmailChangeUnsupported;
    case "invalid-origin":
      return t.errorInvalidOrigin;
    case "invalid-input":
      return error.field === "currentPassword"
        ? t.errorInvalidCurrentPassword
        : t.errorInvalidInput;
    default:
      return t.errorGeneric;
  }
}

/**
 * Message for a failed email settings save or diagnostic delivery. The reported
 * reason is the mailer contract's redacted text; it never carries the SMTP
 * password.
 */
export function emailErrorMessage(error: CoreError, t: Dictionary): string {
  switch (error.kind) {
    case "forbidden":
      return t.emailAdministratorsOnly;
    case "invalid-input":
      return t.emailInvalidInput;
    case "mail-not-configured":
      return error.missing === "smtp"
        ? t.emailNotConfiguredNoSmtp
        : t.emailNotConfiguredNoRecipient;
    case "installation-secret-invalid":
      return error.reason === "missing"
        ? t.emailSecretMissing
        : t.emailSecretTooShort;
    case "mail-diagnostic-cooldown":
      return `${t.emailDiagnosticCooldown} ${error.retryAfterSeconds}s`;
    case "mail-delivery-failed":
      return `${emailFailureStageLabel(error.stage, t)} — ${error.reason}`;
    default:
      return t.errorGeneric;
  }
}

export function emailFailureStageLabel(
  stage: MailFailureStage,
  t: Dictionary,
): string {
  switch (stage) {
    case "connection":
      return t.emailFailureStageConnection;
    case "authentication":
      return t.emailFailureStageAuthentication;
    case "delivery":
      return t.emailFailureStageDelivery;
  }
}
