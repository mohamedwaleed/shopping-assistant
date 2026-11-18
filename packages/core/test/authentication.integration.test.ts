// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import { createDb, DEFAULT_TEST_DATABASE_URL } from "@shopping/db";
import {
  createAuthentication,
  principalForUser,
  readSetupToken,
  type AccountProvisioner,
  type Authentication,
  type Principal,
} from "../src/index";

// Core is the primary seam for installation setup and workspace admission:
// real PostgreSQL, the one-time token from the environment, and the same
// authorization path a direct caller uses (no transport in between).
const TEST_DATABASE_URL =
  process.env.DATABASE_URL_TEST ?? DEFAULT_TEST_DATABASE_URL;

const TOKEN = "operator-held-one-time-setup-token";

/** Stand-in for the identity library: core never hashes or stores passwords. */
function fakeProvisioner(db: Knex): AccountProvisioner & { created: string[] } {
  const created: string[] = [];
  return {
    created,
    createCredentialAccount: async ({ email, name }) => {
      const id = `identity-${created.length + 1}`;
      created.push(email);
      await seedIdentity(db, { id, email, name });
      return { userId: id };
    },
    deleteIdentity: async (userId) => {
      created.splice(created.indexOf(userId), 1);
      await db("user").where({ id: userId }).delete();
    },
    verifyCredentials: async ({ email, password }) =>
      password === "correct-horse-battery"
        ? { userId: created.includes(email) ? `identity-${created.indexOf(email) + 1}` : "" }
        : null,
  };
}

async function count(db: Knex, table: string): Promise<number> {
  const row = await db(table).count("* as count").first();
  return Number(row?.count ?? 0);
}

async function seedIdentity(
  db: Knex,
  input: { id: string; email: string; name?: string },
): Promise<void> {
  await db("user").insert({
    id: input.id,
    name: input.name ?? input.id,
    email: input.email,
    email_verified: false,
  });
}

describe("installation setup and workspace admission through the core", () => {
  let db: Knex;
  let auth: Authentication;
  let provisioner: ReturnType<typeof fakeProvisioner>;

  beforeAll(async () => {
    db = createDb(TEST_DATABASE_URL);
    await db.migrate.rollback({}, true);
    await db.migrate.latest();
  });

  beforeEach(async () => {
    await db("workspace_memberships").delete();
    await db("workspaces").delete();
    await db("session").delete();
    await db("account").delete();
    await db("user").delete();
    await db("installation").update({
      setup_completed_at: null,
      setup_token_hash: null,
      setup_administrator_user_id: null,
    });
    auth = createAuthentication({
      db,
      setupToken: () => ({ kind: "configured", token: TOKEN }),
    });
    provisioner = fakeProvisioner(db);
  });

  afterAll(async () => {
    await db.destroy();
  });

  function claim(overrides: Partial<Parameters<Authentication["claimSetup"]>[0]> = {}) {
    return auth.claimSetup(
      {
        token: TOKEN,
        name: "Ada Admin",
        email: "ada@example.nl",
        password: "correct-horse-battery",
        workspaceName: "Ada's workspace",
        sessionEstablished: true,
        ...overrides,
      },
      provisioner,
    );
  }

  it("reports setup as claimable only while a token is held and unused", async () => {
    expect(await auth.getSetupState()).toEqual({
      ok: true,
      value: { complete: false, claimable: true },
    });

    const withoutToken = createAuthentication({
      db,
      setupToken: () => readSetupToken({}),
    });
    expect(await withoutToken.getSetupState()).toEqual({
      ok: true,
      value: { complete: false, claimable: false },
    });
  });

  it("atomically creates the first administrator and a private workspace", async () => {
    const result = await claim();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.user.email).toBe("ada@example.nl");
    expect(result.value.user.workspace.role).toBe("owner");
    expect(result.value.administrator.userId).toBe(result.value.user.id);

    const workspace = await db("workspaces").where({ id: result.value.user.workspace.workspaceId }).first();
    expect(workspace.name).toBe("Ada's workspace");
    expect(workspace.created_by_user_id).toBe(result.value.user.id);

    const installation = await db("installation").where({ id: 1 }).first();
    expect(installation.setup_completed_at).not.toBeNull();
    expect(installation.setup_administrator_user_id).toBe(result.value.user.id);
    expect(installation.setup_token_hash).not.toBe(TOKEN);

    expect(await auth.getSetupState()).toEqual({
      ok: true,
      value: { complete: true, claimable: false },
    });
  });

  it("rejects a replay without creating a second administrator or workspace", async () => {
    await claim();
    const replay = await claim({ email: "second@example.nl", name: "Second" });

    expect(replay).toEqual({ ok: false, error: { kind: "setup-already-complete" } });
    expect(await count(db, "user")).toBe(1);
    expect(await count(db, "workspaces")).toBe(1);
    expect(provisioner.created).toEqual(["ada@example.nl"]);
  });

  it("admits exactly one of two concurrent claims for the same token", async () => {
    const [first, second] = await Promise.all([
      claim({ email: "first@example.nl", name: "First" }),
      claim({ email: "second@example.nl", name: "Second" }),
    ]);

    const successes = [first, second].filter((result) => result.ok);
    expect(successes).toHaveLength(1);
    expect(await count(db, "user")).toBe(1);
    expect(await count(db, "workspaces")).toBe(1);
    expect(await count(db, "workspace_memberships")).toBe(1);
  });

  it("works without SMTP and never marks the administrator as email-verified", async () => {
    const result = await claim();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const user = await db("user").where({ id: result.value.user.id }).first();
    expect(user.email_verified).toBe(false);
    expect(await count(db, "verification")).toBe(0);
  });

  it("refuses a wrong or missing setup token and leaves setup claimable", async () => {
    expect(await claim({ token: "not-the-token" })).toEqual({
      ok: false,
      error: { kind: "invalid-setup-token" },
    });
    expect(await claim({ token: "" })).toEqual({
      ok: false,
      error: { kind: "invalid-setup-token" },
    });

    const withoutToken = createAuthentication({ db, setupToken: () => readSetupToken({}) });
    const unavailable = await withoutToken.claimSetup(
      {
        token: TOKEN,
        name: "Ada",
        email: "ada@example.nl",
        password: "correct-horse-battery",
        workspaceName: "",
        sessionEstablished: true,
      },
      provisioner,
    );
    expect(unavailable).toEqual({ ok: false, error: { kind: "setup-unavailable" } });

    expect((await auth.getSetupState()).ok && (await auth.getSetupState())).toMatchObject({
      value: { complete: false, claimable: true },
    });
    expect(await count(db, "user")).toBe(0);
  });

  it("validates the administrator's details before spending the token", async () => {
    expect(await claim({ email: "not-an-email" })).toEqual({
      ok: false,
      error: { kind: "invalid-input", field: "email", message: "email must be a valid address" },
    });
    expect(await claim({ password: "short" })).toMatchObject({
      ok: false,
      error: { kind: "invalid-input", field: "password" },
    });
    expect(await claim({ name: "   " })).toMatchObject({
      ok: false,
      error: { kind: "invalid-input", field: "name" },
    });
    expect(await claim({ sessionEstablished: false })).toEqual({
      ok: false,
      error: { kind: "forbidden", capability: "auth.session" },
    });
    expect(await count(db, "user")).toBe(0);
  });

  it("restores the claim when identity provisioning fails", async () => {
    const failing: AccountProvisioner = {
      ...provisioner,
      createCredentialAccount: async () => {
        throw new Error("identity library unavailable");
      },
    };
    await expect(
      auth.claimSetup(
        {
          token: TOKEN,
          name: "Ada",
          email: "ada@example.nl",
          password: "correct-horse-battery",
          workspaceName: "",
          sessionEstablished: true,
        },
        failing,
      ),
    ).rejects.toThrow("identity library unavailable");

    expect(await db("installation").where({ id: 1 }).first()).toMatchObject({
      setup_completed_at: null,
    });
    expect((await claim()).ok).toBe(true);
  });

  describe("workspace admission", () => {
    let administrator: Principal;
    let shopper: Principal;
    let otherWorkspaceId: string;

    beforeEach(async () => {
      const claimed = await claim();
      if (!claimed.ok) throw new Error("setup claim failed");

      await seedIdentity(db, { id: "user-shopper", email: "shopper@example.nl" });
      const [shopperWorkspace] = await db("workspaces")
        .insert({ name: "Shopper workspace", created_by_user_id: "user-shopper" })
        .returning("id");
      await db("workspace_memberships").insert({
        workspace_id: shopperWorkspace.id,
        user_id: "user-shopper",
        role: "owner",
      });
      await seedIdentity(db, { id: "user-other", email: "other@example.nl" });
      const [otherWorkspace] = await db("workspaces")
        .insert({ name: "Other workspace", created_by_user_id: "user-other" })
        .returning("id");
      otherWorkspaceId = otherWorkspace.id;
      await db("workspace_memberships").insert({
        workspace_id: otherWorkspaceId,
        user_id: "user-other",
        role: "owner",
      });

      administrator = principalForUser(
        claimed.value.user.id,
        claimed.value.user.workspace,
        true,
        "session-administrator",
      );
      shopper = principalForUser(
        "user-shopper",
        { workspaceId: shopperWorkspace.id, role: "owner" },
        false,
        "session-shopper",
      );
    });

    it("admits the administrator through stored membership", async () => {
      const result = await auth.admission(administrator);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.email).toBe("ada@example.nl");
      expect(result.value.workspace.role).toBe("owner");
      expect((await auth.administrator(result.value.id)).ok).toBe(true);
    });

    it("rejects a principal that names another workspace", async () => {
      const tampered: Principal = {
        kind: "workspace",
        userId: "user-shopper",
        workspaceId: otherWorkspaceId,
        sessionId: "session-shopper",
      };
      expect(await auth.admission(tampered)).toEqual({
        ok: false,
        error: { kind: "forbidden", capability: "workspace.read" },
      });
    });

    it("keeps two workspaces isolated and anonymous callers out", async () => {
      const own = await auth.admission(shopper);
      expect(own.ok).toBe(true);

      expect(await auth.admission({ kind: "anonymous" })).toEqual({
        ok: false,
        error: { kind: "forbidden", capability: "workspace.read" },
      });
      expect(
        await auth.admission({
          kind: "workspace",
          userId: "user-missing",
          workspaceId: otherWorkspaceId,
          sessionId: "session-missing",
        }),
      ).toEqual({ ok: false, error: { kind: "not-found", resource: "user", id: "user-missing" } });
      expect(
        await auth.admission({
          kind: "workspace",
          userId: "user-shopper",
          workspaceId: "not-a-uuid",
          sessionId: "session-shopper",
        }),
      ).toMatchObject({ ok: false, error: { kind: "invalid-input", field: "workspaceId" } });
    });

    it("does not treat an ordinary workspace user as an installation administrator", async () => {
      expect(await auth.administrator("user-shopper")).toEqual({
        ok: false,
        error: { kind: "forbidden", capability: "installation.manage" },
      });
    });

    it("rejects a session that storage does not hold", async () => {
      // Session lifetime itself is covered by sessions.integration.test.ts;
      // here only the admission boundary is asserted.
      expect(await auth.requireSession("user-shopper", "session-missing")).toEqual({
        ok: false,
        error: { kind: "invalid-credentials" },
      });
      expect(await auth.requireSession("user-shopper", "")).toEqual({
        ok: false,
        error: { kind: "invalid-credentials" },
      });
    });
  });

  describe("admission after setup", () => {
    it("keeps public registration closed", async () => {
      expect(
        await auth.signUp(
          { name: "Mallory", email: "mallory@example.nl", sessionEstablished: true },
          provisioner,
        ),
      ).toEqual({ ok: false, error: { kind: "registration-closed" } });
      expect(await count(db, "user")).toBe(0);
    });

    it("signs in an admitted user and refuses an unknown one", async () => {
      const claimed = await claim();
      if (!claimed.ok) throw new Error("setup claim failed");

      const signedIn = await auth.signIn(
        { email: "Ada@Example.nl", password: "correct-horse-battery", sessionEstablished: true },
        provisioner,
      );
      expect(signedIn.ok).toBe(true);
      if (!signedIn.ok) return;
      expect(signedIn.value.id).toBe(claimed.value.user.id);

      expect(
        await auth.signIn(
          { email: "ada@example.nl", password: "wrong-password", sessionEstablished: true },
          provisioner,
        ),
      ).toEqual({ ok: false, error: { kind: "invalid-credentials" } });
      expect(
        await auth.signIn(
          { email: "ada@example.nl", password: "correct-horse-battery", sessionEstablished: false },
          provisioner,
        ),
      ).toEqual({ ok: false, error: { kind: "forbidden", capability: "auth.session" } });
    });

    it("reports sign-out only when the stored session was revoked", async () => {
      expect(await auth.signOut({ sessionRevoked: true })).toEqual({
        ok: true,
        value: { signedOut: true },
      });
      expect(await auth.signOut({ sessionRevoked: false })).toEqual({
        ok: false,
        error: { kind: "forbidden", capability: "auth.session" },
      });
    });
  });
});
