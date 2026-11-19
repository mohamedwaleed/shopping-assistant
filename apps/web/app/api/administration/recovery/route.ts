// SPDX-License-Identifier: AGPL-3.0-or-later
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * There is deliberately no public administrator recovery endpoint. Losing the
 * administrator's password is an operator problem, not a browser one: it is
 * recovered with `pnpm admin:recover` on the host (docs/runbooks/administrator-recovery.md),
 * which needs the deployment's environment. This route exists only so a
 * caller gets an unambiguous refusal instead of a stray handler.
 */
export async function POST(): Promise<Response> {
  return errorResponse({ kind: "not-found", resource: "administrator-recovery", id: "public" });
}
