// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, DEFAULT_TEST_DATABASE_URL } from "@shopping/db";
import { createChatSessions, type Principal } from "../src/index";
import type { Knex } from "knex";

const url = process.env.DATABASE_URL_TEST ?? DEFAULT_TEST_DATABASE_URL;
const firstWorkspace = "11111111-1111-4111-8111-111111111111";
const secondWorkspace = "22222222-2222-4222-8222-222222222222";
const principal: Principal = { kind: "workspace", userId: "chat-user", workspaceId: firstWorkspace, sessionId: "chat-session" };

describe("shopping sessions through the core", () => {
  let db: Knex;
  let chat: ReturnType<typeof createChatSessions>;
  beforeAll(async () => { db = createDb(url); await db.migrate.rollback({}, true); await db.migrate.latest(); chat = createChatSessions({ db }); });
  beforeEach(async () => {
    await db("shopping_session_messages").delete(); await db("shopping_session_requirements").delete(); await db("shopping_sessions").delete();
    await db("workspace_memberships").delete(); await db("workspaces").delete(); await db("user").delete();
    await db("user").insert([{ id: "chat-user", name: "Chat user", email: "chat@example.nl" }, { id: "other-user", name: "Other", email: "other@example.nl" }]);
    await db("workspaces").insert([{ id: firstWorkspace, name: "First", created_by_user_id: "chat-user" }, { id: secondWorkspace, name: "Second", created_by_user_id: "other-user" }]);
    await db("workspace_memberships").insert([{ workspace_id: firstWorkspace, user_id: "chat-user", role: "owner" }, { workspace_id: secondWorkspace, user_id: "other-user", role: "owner" }]);
  });
  afterAll(async () => { await db.destroy(); });

  it("persists visible requirements separately from messages and preserves must-haves across revisions", async () => {
    const created = await chat.create(principal, { language: "nl", title: "Laptop" });
    expect(created).toMatchObject({ ok: true, value: { language: "nl" } });
    if (!created.ok) return;
    await chat.appendMessage(principal, created.value.id, { role: "user", content: "Een stille laptop onder €1000" });
    await chat.applyRequirements(principal, created.value.id, { mustHaves: ["onder €1000"], preferences: ["stil"], assumptions: ["Nederlandse levering"], questions: ["Welke schermgrootte?"], revisionNote: "first extraction" });
    await chat.applyRequirements(principal, created.value.id, { mustHaves: [], preferences: ["stil", "lichtgewicht"], assumptions: [], questions: [], revisionNote: "shopper revision" });
    const reloaded = await chat.get(principal, created.value.id);
    expect(reloaded).toMatchObject({ ok: true, value: { messages: [{ role: "user" }], requirements: { mustHaves: ["onder €1000"], preferences: ["stil", "lichtgewicht"], assumptions: [], questions: [], revision: 2 } } });
  });

  it("does not expose another workspace's session", async () => {
    const created = await chat.create(principal, { language: "en", title: "Camera" }); if (!created.ok) return;
    const other: Principal = { kind: "workspace", userId: "other-user", workspaceId: secondWorkspace, sessionId: "other-session" };
    await expect(chat.get(other, created.value.id)).resolves.toMatchObject({ ok: false, error: { kind: "not-found", resource: "shopping-session" } });
  });
});
