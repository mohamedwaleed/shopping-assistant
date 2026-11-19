// SPDX-License-Identifier: AGPL-3.0-or-later
import type { CoreError } from "@shopping/core";

const STATUS_BY_KIND: Record<CoreError["kind"], number> = {
  "invalid-input": 400,
  forbidden: 403,
  "not-found": 404,
  "setup-already-complete": 409,
  "setup-unavailable": 503,
  "invalid-setup-token": 403,
  "registration-closed": 403,
  "access-disabled": 403,
  "invalid-credentials": 401,
  "reauthentication-required": 403,
  "email-change-unsupported": 409,
  "invalid-email-link": 400,
  /** The request came from another origin than the one it was sent to. */
  "invalid-origin": 403,
  "mail-not-configured": 409,
  // An operator environment mistake; nothing can be encrypted or decrypted.
  "installation-secret-invalid": 500,
  "mail-diagnostic-cooldown": 429,
  // The upstream SMTP server failed, not this request; the stage says which.
  "mail-delivery-failed": 502,
  // Configuration problems are conflicts with the installation's state, not
  // server faults: the caller must configure a model or credential.
  "model-not-configured": 409,
  "model-credential-missing": 409,
  "model-credential-provider-mismatch": 409,
  "provider-unavailable": 502,
  "budget-paused": 409,
  "background-personal-key-consent-required": 409,
  "budget-retry-exhausted": 409,
};

export function errorResponse(error: CoreError): Response {
  return Response.json(
    { error },
    { status: STATUS_BY_KIND[error.kind] ?? 500 },
  );
}
