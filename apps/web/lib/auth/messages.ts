// SPDX-License-Identifier: AGPL-3.0-or-later
import type { CoreError } from "@shopping/core";
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
