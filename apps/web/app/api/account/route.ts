// SPDX-License-Identifier: AGPL-3.0-or-later
import { getCore, getDb } from "@/lib/core";
import { requestIdentity } from "@/lib/auth/session";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/** The signed-in user and their private workspace, resolved from storage. */
export async function GET(request: Request): Promise<Response> {
  const identity = await requestIdentity(request);
  if (!identity) return errorResponse({ kind: "forbidden", capability: "workspace.read" });

  const admission = await getCore().auth.admission(identity.trusted.principal);
  if (!admission.ok) return errorResponse(admission.error);

  const db = getDb();
  const workspace = await db("workspaces")
    .where({ id: admission.value.workspace.workspaceId })
    .select("id", "name")
    .first();

  return Response.json({
    user: {
      id: admission.value.id,
      email: admission.value.email,
      name: admission.value.name,
    },
    workspace: {
      id: admission.value.workspace.workspaceId,
      name: workspace?.name ?? "",
      role: admission.value.workspace.role,
    },
    principalKind: identity.trusted.principal.kind,
  });
}
