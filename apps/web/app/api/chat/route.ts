// SPDX-License-Identifier: AGPL-3.0-or-later
import { jsonSchema, stepCountIs, streamText, tool } from "ai";
import type { SessionRequirements } from "@shopping/core";
import { getCore } from "@/lib/core";
import { errorResponse } from "@/lib/http";
import { languageModel } from "@/lib/models/ai-sdk-probe";
import { jsonBody, settingsPrincipal, unauthenticated } from "@/lib/models/request";

function lastUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (const message of [...messages].reverse()) {
    if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "user") continue;
    const parts = (message as { parts?: unknown }).parts;
    if (!Array.isArray(parts)) continue;
    return parts.flatMap((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string" ? [(part as { text: string }).text] : []).join(" ").trim();
  }
  return "";
}

function shopperPrompt(requirements: SessionRequirements, text: string): string {
  return `You are a bilingual Dutch shopping assistant. Call the requirements_update tool when the shopper describes or revises needs. Existing must-haves: ${JSON.stringify(requirements.mustHaves)}. Preferences: ${JSON.stringify(requirements.preferences)}. Shopper: ${text}`;
}

/**
 * Authenticated streaming transport. The model receives only bounded private
 * session state.
 *
 * Which account pays is the workspace's own stored usage source, never a
 * provider's availability: a workspace that selected its ChatGPT plan is served
 * through that connection, and a paused, expired or refused plan ends the turn
 * as a typed error instead of silently billing a stored API key. A workspace
 * that selected API-key usage keeps using its configured model.
 */
export async function POST(request: Request): Promise<Response> {
  const principal = await settingsPrincipal(request);
  if (!principal) return unauthenticated();
  const body = await jsonBody(request);
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  const text = lastUserText(body.messages);
  if (!text) return errorResponse({ kind: "invalid-input", field: "messages", message: "a user message is required" });
  const core = getCore();
  const session = await core.chat.get(principal, sessionId);
  if (!session.ok) return errorResponse(session.error);

  const plan = await core.chatgptPlan.read(principal);
  if (!plan.ok) return errorResponse(plan.error);
  const usePlan = plan.value.usageSource === "chatgpt-plan" && plan.value.status !== "disconnected";

  // Resolve the payer the workspace selected. A plan resolution and an API-key
  // resolution are different requests: neither is substituted for the other.
  const planRequest = usePlan ? await core.chatgptPlan.resolve(principal) : null;
  // The workspace selected the plan, so it is resolved or the turn fails: a
  // missing connection, a paused plan or an expired token is never answered by
  // quietly resolving the configured API key instead.
  const apiKeyRequest = usePlan ? null : await core.models.resolve(principal);
  if (planRequest && !planRequest.ok) return errorResponse(planRequest.error);
  if (apiKeyRequest && !apiKeyRequest.ok) return errorResponse(apiKeyRequest.error);
  const usageSource = planRequest ? ("chatgpt-plan" as const) : apiKeyRequest!.value.usageSource;
  // A plan connection is billed to the workspace's own account, so the budget
  // reservation is recorded against the workspace rather than the installation.
  const billingSource: "installation" | "workspace" = planRequest ? "workspace" : apiKeyRequest!.value.usageSource;
  const reservation = await core.budgets.reserve(principal, { kind: "interactive", estimatedCents: 1, usageSource: billingSource });
  if (!reservation.ok) return errorResponse(reservation.error);
  const savedUser = await core.chat.appendMessage(principal, sessionId, { role: "user", content: text });
  if (!savedUser.ok) { await core.budgets.cancel(principal, reservation.value.id); return errorResponse(savedUser.error); }

  const prompt = shopperPrompt(session.value.requirements, text);
  const requirementsTool = tool({
    description: "Persist visible must-haves, preferences, assumptions, and material clarification questions.",
    inputSchema: jsonSchema<{ mustHaves: string[]; preferences: string[]; assumptions: string[]; questions: string[]; revisionNote: string }>({ type: "object", properties: { mustHaves: { type: "array", items: { type: "string" } }, preferences: { type: "array", items: { type: "string" } }, assumptions: { type: "array", items: { type: "string" } }, questions: { type: "array", items: { type: "string" } }, revisionNote: { type: "string" } }, required: ["mustHaves", "preferences", "assumptions", "questions", "revisionNote"], additionalProperties: false }),
    execute: async (input) => {
      if (![input.mustHaves, input.preferences, input.assumptions, input.questions].every(Array.isArray) || typeof input.revisionNote !== "string") throw new Error("invalid requirements tool output");
      const updated = await core.chat.applyRequirements(principal, sessionId, input);
      if (!updated.ok) throw new Error(updated.error.kind);
      return updated.value;
    },
  });

  if (planRequest) {
    // The plan route answers only as a stream, so the adapter consumes the whole
    // turn. Its report says whether the shopping tool was called *and executed*;
    // a text-only answer is recorded as text, never as a saved update.
    const history = session.value.messages
      .filter((message): message is typeof message & { role: "user" | "assistant" } => message.role !== "tool")
      .slice(-12)
      .map((message) => ({ role: message.role, content: message.content }));
    const exercised = await core.chatgptPlan.exercisePlan(principal, {
      prompt,
      tools: ["requirements_update"],
      messages: history,
    });
    if (!exercised.ok) { await core.budgets.cancel(principal, reservation.value.id); return errorResponse(exercised.error); }
    const reply = exercised.value.text.trim();
    if (reply) await core.chat.appendMessage(principal, sessionId, { role: "assistant", content: reply });
    await core.budgets.settle(principal, reservation.value.id, 1);
    // The tool report is returned as facts; whether a requirements update really
    // happened is the `toolsExecuted` list, not a claim in the reply text.
    return Response.json({
      usageSource,
      modelId: exercised.value.modelId,
      reply,
      toolCalls: exercised.value.toolCalls,
      toolsExecuted: exercised.value.toolsExecuted,
    });
  }

  const result = streamText({
    model: languageModel(apiKeyRequest!.value, apiKeyRequest!.value.apiKey),
    maxOutputTokens: 256,
    maxRetries: 0,
    stopWhen: stepCountIs(2),
    prompt,
    tools: { requirements_update: requirementsTool },
  });
  void Promise.resolve(result.text).then(async (reply) => { if (reply.trim()) await core.chat.appendMessage(principal, sessionId, { role: "assistant", content: reply }); await core.budgets.settle(principal, reservation.value.id, 1); }).catch(async () => { await core.budgets.cancel(principal, reservation.value.id); });
  return result.toUIMessageStreamResponse();
}
