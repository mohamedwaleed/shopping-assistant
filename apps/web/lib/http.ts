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
};

export function errorResponse(error: CoreError): Response {
  return Response.json(
    { error },
    { status: STATUS_BY_KIND[error.kind] ?? 500 },
  );
}
