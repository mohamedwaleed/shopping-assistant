// SPDX-License-Identifier: AGPL-3.0-or-later
import { jsonSchema, stepCountIs, streamText, tool } from "ai";
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

/** Authenticated streaming transport. The model receives only bounded private session state. */
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
  const model = await core.models.resolve(principal);
  if (!model.ok) return errorResponse(model.error);
  const reservation = await core.budgets.reserve(principal, { kind: "interactive", estimatedCents: 1, usageSource: model.value.usageSource });
  if (!reservation.ok) return errorResponse(reservation.error);
  const savedUser = await core.chat.appendMessage(principal, sessionId, { role: "user", content: text });
  if (!savedUser.ok) { await core.budgets.cancel(principal, reservation.value.id); return errorResponse(savedUser.error); }
  const requirements = session.value.requirements;
  const result = streamText({
    model: languageModel(model.value, model.value.apiKey),
    maxOutputTokens: 256,
    maxRetries: 0,
    stopWhen: stepCountIs(2),
    prompt: `You are a bilingual Dutch shopping assistant. Call the requirements_update tool when the shopper describes or revises needs. Existing must-haves: ${JSON.stringify(requirements.mustHaves)}. Preferences: ${JSON.stringify(requirements.preferences)}. Shopper: ${text}`,
    tools: {
      requirements_update: tool({
        description: "Persist visible must-haves, preferences, assumptions, and material clarification questions.",
        inputSchema: jsonSchema<{ mustHaves: string[]; preferences: string[]; assumptions: string[]; questions: string[]; revisionNote: string }>({ type: "object", properties: { mustHaves: { type: "array", items: { type: "string" } }, preferences: { type: "array", items: { type: "string" } }, assumptions: { type: "array", items: { type: "string" } }, questions: { type: "array", items: { type: "string" } }, revisionNote: { type: "string" } }, required: ["mustHaves", "preferences", "assumptions", "questions", "revisionNote"], additionalProperties: false }),
        execute: async (input) => {
          if (![input.mustHaves, input.preferences, input.assumptions, input.questions].every(Array.isArray) || typeof input.revisionNote !== "string") throw new Error("invalid requirements tool output");
          const updated = await core.chat.applyRequirements(principal, sessionId, input);
          if (!updated.ok) throw new Error(updated.error.kind);
          return updated.value;
        },
      }),
    },
  });
  void Promise.resolve(result.text).then(async (reply) => { if (reply.trim()) await core.chat.appendMessage(principal, sessionId, { role: "assistant", content: reply }); await core.budgets.settle(principal, reservation.value.id, 1); }).catch(async () => { await core.budgets.cancel(principal, reservation.value.id); });
  return result.toUIMessageStreamResponse();
}
