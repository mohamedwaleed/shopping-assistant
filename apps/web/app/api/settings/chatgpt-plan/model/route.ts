// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ChatGPTPlanModel } from "@shopping/core";
import { getCore } from "@/lib/core";
import { errorResponse } from "@/lib/http";
import { sameOriginRejected } from "@/lib/csrf";
import { jsonBody, settingsPrincipal, unauthenticated } from "@/lib/models/request";

export const dynamic = "force-dynamic";

function modelsFrom(value: unknown): ChatGPTPlanModel[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const models = value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.modelId !== "string") return [];
    return [
      {
        modelId: record.modelId,
        displayName: typeof record.displayName === "string" ? record.displayName : record.modelId,
      },
    ];
  });
  return models.length > 0 ? models : undefined;
}

/**
 * Choose one of the account's own models. The account's model list is supplied
 * by whoever discovered it (`GET /v1/models` with this connection's token) and
 * core refuses a model the account did not list, so a model cannot be selected
 * from another account's catalogue.
 */
export async function PUT(request: Request): Promise<Response> {
  const principal = await settingsPrincipal(request);
  if (!principal) return unauthenticated();
  if (sameOriginRejected(request)) return errorResponse({ kind: "invalid-origin" });

  const body = await jsonBody(request);
  const result = await getCore().chatgptPlan.selectModel(
    principal,
    {
      slug: typeof body.modelId === "string" ? body.modelId : "",
      ...(typeof body.displayName === "string" ? { displayName: body.displayName } : {}),
    },
    modelsFrom(body.available),
  );
  if (!result.ok) return errorResponse(result.error);
  return Response.json({ selectedModel: result.value });
}
