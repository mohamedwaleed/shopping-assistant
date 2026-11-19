// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import { createDb, DEFAULT_TEST_DATABASE_URL } from "@shopping/db";
import {
  createAuthentication,
  principalForUser,
  RECENT_AUTHENTICATION_SECONDS,
  SESSION_ABSOLUTE_SECONDS,
  SESSION_INACTIVITY_SECONDS,
  type AccountProvisioner,
  type Authentication,
  type Principal,
} from "../src/index";

// Device, session and credential authorization through the core: real
// PostgreSQL, a clock the test controls, and the same path a direct caller
// takes. Sessions are stored rows, so revocation, the inactivity window and
// the absolute maximum are all decided from storage rather than from a cookie.
const TEST_DATABASE_URL =
  process.env.DATABASE_URL_TEST ?? DEFAULT_TEST_DATABASE_URL;

const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN = "session-device-one-time-setup-token";

interface Identity {
  userId: string;
  workspaceId: string;
  sessionId: string;
  token: string;
  principal: Principal;
}

function fakeProvisioner(): AccountProvisioner {
  return {
    createCredentialAccount: async () => {
      throw new Error("the session tests provision identities directly");
    },
    deleteIdentity: async () => {
      throw new Error("the session tests never delete identities");
    },
    verifyCredentials: async () => null,
  };
}

describe("devices, sessions and password changes through the core", () => {
  let db: Knex;
  let auth: Authentication;
  let clock: Date;

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
    clock = new Date("2026-11-18T09:00:00.000Z");
    auth = createAuthentication({
      db,
      now: () => clock,
      setupToken: () => ({ kind: "configured", token: TOKEN }),
    });
  });

  afterAll(async () => {
    await db.destroy();
  });

  function advance(milliseconds: number): void {
    clock = new Date(clock.getTime() + milliseconds);
  }

  async function provisionPerson(
    email: string,
    workspaceName: string,
  ): Promise<{ userId: string; workspaceId: string }> {
    // Identity ids are text, so fixed identifiers keep the tests readable.
    const userId = `identity-${email}`;
    await db("user").insert({ id: userId, name: email, email, email_verified: false });
    await db("account").insert({
      id: `account-${userId}`,
      account_id: userId,
      provider_id: "credential",
      user_id: userId,
      password: "not-used-by-core",
    });
    const [workspace] = await db("workspaces")
      .insert({ name: workspaceName, created_by_user_id: userId })
      .returning("id");
    await db("workspace_memberships").insert({
      workspace_id: workspace.id,
      user_id: userId,
      role: "owner",
    });
    return { userId, workspaceId: workspace.id };
  }

  /** Store a session the way the identity library does after a sign-in. */
  async function startSession(
    userId: string,
    input: { ipAddress?: string; userAgent?: string } = {},
  ): Promise<{ sessionId: string; token: string }> {
    const suffix = Math.random().toString(36).slice(2, 10);
    const [row] = await db("session")
      .insert({
        id: `session-${suffix}`,
        token: `token-${suffix}`,
        user_id: userId,
        expires_at: new Date(clock.getTime() + SESSION_INACTIVITY_SECONDS * 1000),
        created_at: clock,
        updated_at: clock,
        ip_address: input.ipAddress ?? "203.0.113.10",
        user_agent: input.userAgent ?? "Mozilla/5.0 (Macintosh) Firefox/128.0",
      })
      .returning(["id", "token"]);
    return { sessionId: row.id, token: row.token };
  }

  async function person(
    email: string,
    workspaceName: string,
  ): Promise<Identity> {
    const { userId, workspaceId } = await provisionPerson(email, workspaceName);
    const session = await startSession(userId);
    return {
      userId,
      workspaceId,
      sessionId: session.sessionId,
      token: session.token,
      principal: principalForUser(
        userId,
        { workspaceId, role: "owner" },
        false,
        session.sessionId,
      ),
    };
  }

  function stored(sessionId: string) {
    return db("session").where({ id: sessionId }).first();
  }

  describe("stored sessions", () => {
    it("accepts a live session and reports its inactivity expiry", async () => {
      const ada = await person("ada@example.nl", "Ada's workspace");

      const result = await auth.requireSession(ada.userId, ada.sessionId);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual({
        userId: ada.userId,
        sessionId: ada.sessionId,
        expiresAt: new Date(clock.getTime() + SESSION_INACTIVITY_SECONDS * 1000).toISOString(),
        createdAt: clock.toISOString(),
        lastActiveAt: clock.toISOString(),
      });
      // Reading the session is the activity that keeps it alive.
      expect((await stored(ada.sessionId)).updated_at.toISOString()).toBe(clock.toISOString());
    });

    it("rejects an unknown, revoked or other user's session", async () => {
      const ada = await person("ada@example.nl", "Ada's workspace");
      const sam = await person("sam@example.nl", "Sam's workspace");

      expect(await auth.requireSession(ada.userId, "session-missing")).toEqual({
        ok: false,
        error: { kind: "invalid-credentials" },
      });
      expect(await auth.requireSession(ada.userId, sam.sessionId)).toEqual({
        ok: false,
        error: { kind: "invalid-credentials" },
      });
      expect(await auth.requireSession("", ada.sessionId)).toEqual({
        ok: false,
        error: { kind: "invalid-credentials" },
      });

      await auth.revokeSession(ada.principal, { sessionId: ada.sessionId });
      expect(await auth.requireSession(ada.userId, ada.sessionId)).toEqual({
        ok: false,
        error: { kind: "invalid-credentials" },
      });
    });

    it("expires a session after seven days without use", async () => {
      const ada = await person("ada@example.nl", "Ada's workspace");

      advance(6 * DAY_MS);
      expect((await auth.requireSession(ada.userId, ada.sessionId)).ok).toBe(true);

      // Any admitted use of the session restarts the inactivity window.
      advance(6 * DAY_MS);
      const mid = await auth.requireSession(ada.userId, ada.sessionId);
      expect(mid.ok).toBe(true);
      if (mid.ok) expect(mid.value.lastActiveAt).toBe(clock.toISOString());
      // Seven days after the last use, to the second, the session is gone.
      advance(SESSION_INACTIVITY_SECONDS * 1000);
      expect(await auth.requireSession(ada.userId, ada.sessionId)).toEqual({
        ok: false,
        error: { kind: "invalid-credentials" },
      });
      expect(await stored(ada.sessionId)).toBeUndefined();
    });

    it("enforces the thirty-day absolute maximum however often it is used", async () => {
      const ada = await person("ada@example.nl", "Ada's workspace");

      // Daily use keeps the idle window open, so it is the maximum that ends
      // the session thirty days after sign-in.
      for (let day = 1; day < 30; day += 1) {
        advance(DAY_MS);
        expect((await auth.requireSession(ada.userId, ada.sessionId)).ok).toBe(true);
      }

      expect((await stored(ada.sessionId)).created_at.toISOString()).toBe(
        "2026-11-18T09:00:00.000Z",
      );
      // Day 29 was used a moment ago, so only the maximum ends the session.
      advance(DAY_MS - 1000);
      expect((await auth.requireSession(ada.userId, ada.sessionId)).ok).toBe(true);
      advance(1000);
      const after = await auth.requireSession(ada.userId, ada.sessionId);
      expect(after).toEqual({
        ok: false,
        error: { kind: "invalid-credentials" },
      });
      expect(await stored(ada.sessionId)).toBeUndefined();
    });

    it("reports the sooner of the idle window and the maximum", async () => {
      const ada = await person("ada@example.nl", "Ada's workspace");

      // A use on day 4 keeps the idle window open.
      advance(3 * DAY_MS);
      expect((await auth.requireSession(ada.userId, ada.sessionId)).ok).toBe(true);

      // On day 10 the idle window from day 4 is still open, so it is reported.
      advance(6 * DAY_MS);
      const late = await auth.requireSession(ada.userId, ada.sessionId);
      expect(late.ok).toBe(true);
      if (late.ok) expect(late.value.expiresAt).toBe("2026-11-28T09:00:00.000Z");
    });

    it("keeps the inactivity window moving without moving the creation time", async () => {
      const ada = await person("ada@example.nl", "Ada's workspace");

      for (let day = 1; day <= 20; day += 1) {
        advance(DAY_MS);
        expect((await auth.requireSession(ada.userId, ada.sessionId)).ok).toBe(true);
      }
      // Daily use moves the inactivity window; the creation time stays fixed.
      const row = await stored(ada.sessionId);
      expect(row.created_at.toISOString()).toBe("2026-11-18T09:00:00.000Z");
      expect(row.updated_at.toISOString()).toBe(clock.toISOString());

      advance(20 * DAY_MS);
      expect(await auth.requireSession(ada.userId, ada.sessionId)).toEqual({
        ok: false,
        error: { kind: "invalid-credentials" },
      });
      expect(await stored(ada.sessionId)).toBeUndefined();
    });

    it("lists devices with the activity times they really have", async () => {
      const ada = await person("ada@example.nl", "Ada's workspace");
      const second = await startSession(ada.userId, {
        ipAddress: "198.51.100.4",
        userAgent: "Mozilla/5.0 (iPhone) Safari/17.0",
      });

      advance(2 * DAY_MS);
      await auth.requireSession(ada.userId, second.sessionId);

      const secondPrincipal = principalForUser(
        ada.userId,
        { workspaceId: ada.workspaceId, role: "owner" },
        false,
        second.sessionId,
      );
      const result = await auth.listSessions(secondPrincipal);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.sessions).toHaveLength(2);
      const [current, other] = result.value.sessions;
      expect(current).toMatchObject({
        id: second.sessionId,
        current: true,
        ipAddress: "198.51.100.4",
        userAgent: "Mozilla/5.0 (iPhone) Safari/17.0",
        lastActiveAt: clock.toISOString(),
        expiresAt: new Date(clock.getTime() + 7 * DAY_MS).toISOString(),
      });
      expect(other).toMatchObject({ id: ada.sessionId, current: false });
      expect(other?.lastActiveAt).toBe(new Date("2026-11-18T09:00:00.000Z").toISOString());
    });

    it("hides expired devices and other people's sessions", async () => {
      const ada = await person("ada@example.nl", "Ada's workspace");
      const sam = await person("sam@example.nl", "Sam's workspace");
      const stale = await startSession(ada.userId);

      // Past the inactivity window the first device is gone from the list.
      advance(6 * DAY_MS);
      await auth.requireSession(ada.userId, stale.sessionId);
      advance(8 * DAY_MS);
      const fresh = await startSession(ada.userId);
      const result = await auth.listSessions(
        principalForUser(
          ada.userId,
          { workspaceId: ada.workspaceId, role: "owner" },
          false,
          fresh.sessionId,
        ),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.sessions).toHaveLength(1);
      expect(result.value.sessions[0]).toMatchObject({ id: fresh.sessionId, current: true });
      expect(result.value.sessions.map((session) => session.id)).not.toContain(stale.sessionId);
      expect(result.value.sessions.map((session) => session.id)).not.toContain(sam.sessionId);
    });

    it("revokes one device and refuses another person's session", async () => {
      const ada = await person("ada@example.nl", "Ada's workspace");
      const sam = await person("sam@example.nl", "Sam's workspace");

      expect(
        await auth.revokeSession(ada.principal, { sessionId: sam.sessionId }),
      ).toEqual({ ok: false, error: { kind: "not-found", resource: "session", id: sam.sessionId } });
      expect(await stored(sam.sessionId)).toBeDefined();

      expect(
        await auth.revokeSession(ada.principal, { sessionId: ada.sessionId }),
      ).toEqual({ ok: true, value: { revoked: 1 } });
      expect(await stored(ada.sessionId)).toBeUndefined();
      expect((await auth.requireSession(sam.userId, sam.sessionId)).ok).toBe(true);
    });

    it("revokes every device and leaves other accounts signed in", async () => {
      const ada = await person("ada@example.nl", "Ada's workspace");
      await startSession(ada.userId);
      const sam = await person("sam@example.nl", "Sam's workspace");

      const result = await auth.revokeAllSessions(ada.principal);
      expect(result).toEqual({ ok: true, value: { revoked: 2 } });

      // Every device of the account is signed out, including the caller's.
      expect((await auth.requireSession(ada.userId, ada.sessionId)).ok).toBe(false);
      expect(await auth.listSessions(ada.principal)).toEqual({
        ok: false,
        error: { kind: "invalid-credentials" },
      });
      // Another account keeps working.
      expect((await auth.requireSession(sam.userId, sam.sessionId)).ok).toBe(true);

      expect(await auth.revokeAllSessions(ada.principal)).toEqual({
        ok: false,
        error: { kind: "invalid-credentials" },
      });
    });

    it("refuses anonymous callers and principals naming another workspace", async () => {
      const ada = await person("ada@example.nl", "Ada's workspace");
      const sam = await person("sam@example.nl", "Sam's workspace");
      const tampered: Principal = {
        kind: "workspace",
        userId: ada.userId,
        workspaceId: sam.workspaceId,
        sessionId: ada.sessionId,
      };

      for (const principal of [{ kind: "anonymous" } as const, tampered]) {
        expect(await auth.listSessions(principal)).toEqual({
          ok: false,
          error: { kind: "forbidden", capability: "workspace.read" },
        });
        expect(await auth.revokeSession(principal, { sessionId: ada.sessionId })).toEqual({
          ok: false,
          error: { kind: "forbidden", capability: "workspace.read" },
        });
        expect(await auth.revokeAllSessions(principal)).toEqual({
          ok: false,
          error: { kind: "forbidden", capability: "workspace.read" },
        });
      }
      expect(await stored(ada.sessionId)).toBeDefined();
    });

    it("rejects a malformed session identifier as invalid input", async () => {
      const ada = await person("ada@example.nl", "Ada's workspace");
      expect(await auth.revokeSession(ada.principal, { sessionId: "  " })).toEqual({
        ok: false,
        error: {
          kind: "invalid-input",
          field: "sessionId",
          message: "sessionId is required",
        },
      });
    });
  });

  describe("recent authentication for credential changes", () => {
    it("reports whether the current session was authenticated recently", async () => {
      const ada = await person("ada@example.nl", "Ada's workspace");

      expect(await auth.recentAuthentication(ada.principal)).toMatchObject({
        ok: true,
        value: {
          recent: true,
          authenticatedAt: clock.toISOString(),
          windowSeconds: RECENT_AUTHENTICATION_SECONDS,
        },
      });

      // Ordinary use inside the window does not restart the clock: the
      // measurement is the sign-in, not the latest request.
      advance(RECENT_AUTHENTICATION_SECONDS * 1000 - 3000);
      await auth.requireSession(ada.userId, ada.sessionId);
      advance(1000);
      expect(await auth.recentAuthentication(ada.principal)).toMatchObject({
        ok: true,
        value: { recent: true, authenticatedAt: "2026-11-18T09:00:00.000Z" },
      });

      // Past the window the session is still valid, but not recently
      // authenticated.
      advance(RECENT_AUTHENTICATION_SECONDS * 1000 + 3000);
      expect(await auth.recentAuthentication(ada.principal)).toMatchObject({
        ok: true,
        value: { recent: false, authenticatedAt: "2026-11-18T09:00:00.000Z" },
      });
    });

    it("does not count a continuously-used session as recently authenticated", async () => {
      const ada = await person("ada@example.nl", "Ada's workspace");
      const credentials = {
        changePassword: async () => {
          throw new Error("must not run");
        },
        setPassword: async () => {
          throw new Error("must not run");
        },
        changeEmail: async () => {
          throw new Error("must not run");
        },
      };

      // A request every day for ten days: the session stays alive, but it was
      // authenticated at sign-in and never again.
      for (let day = 1; day <= 10; day += 1) {
        advance(DAY_MS);
        expect((await auth.requireSession(ada.userId, ada.sessionId)).ok).toBe(true);
      }
      expect((await stored(ada.sessionId)).updated_at.toISOString()).toBe(clock.toISOString());
      expect(await auth.recentAuthentication(ada.principal)).toEqual({
        ok: true,
        value: {
          recent: false,
          authenticatedAt: "2026-11-18T09:00:00.000Z",
          windowSeconds: RECENT_AUTHENTICATION_SECONDS,
        },
      });
      expect(
        await auth.changePassword(
          ada.principal,
          { currentPassword: "current-passphrase", newPassword: "next-passphrase-1" },
          credentials,
        ),
      ).toEqual({ ok: false, error: { kind: "reauthentication-required" } });
    });

    it("changes the password only after recent authentication", async () => {
      const ada = await person("ada@example.nl", "Ada's workspace");
      const changes: Array<{
        userId: string;
        currentPassword: string;
        newPassword: string;
        sessionId: string;
      }> = [];
      const credentials = {
        changePassword: async (input: {
          userId: string;
          currentPassword: string;
          newPassword: string;
          sessionId: string;
        }) => {
          changes.push(input);
        },
        setPassword: async () => {
          throw new Error("must not run");
        },
        changeEmail: async () => {
          throw new Error("email changes belong to the SMTP-backed account flows");
        },
      };

      advance(RECENT_AUTHENTICATION_SECONDS * 1000 + 3000);
      expect(
        await auth.changePassword(
          ada.principal,
          { currentPassword: "current-passphrase", newPassword: "next-passphrase-1" },
          credentials,
        ),
      ).toEqual({ ok: false, error: { kind: "reauthentication-required" } });
      expect(changes).toEqual([]);
      expect(await stored(ada.sessionId)).toBeDefined();

      // Signing in again is what makes a session recent.
      const fresh = await startSession(ada.userId);
      const freshPrincipal = principalForUser(
        ada.userId,
        { workspaceId: ada.workspaceId, role: "owner" },
        false,
        fresh.sessionId,
      );
      expect(
        await auth.changePassword(
          freshPrincipal,
          { currentPassword: "current-passphrase", newPassword: "next-passphrase-1" },
          credentials,
        ),
      ).toEqual({ ok: true, value: { changed: true, otherSessionsRevoked: 1 } });
      expect(changes).toEqual([
        {
          userId: ada.userId,
          currentPassword: "current-passphrase",
          newPassword: "next-passphrase-1",
          sessionId: fresh.sessionId,
        },
      ]);
      // The other device cannot keep using the old password's sessions.
      expect(await stored(ada.sessionId)).toBeUndefined();
      expect(await stored(fresh.sessionId)).toBeDefined();
    });

    it("validates the password change before asking for recent authentication", async () => {
      const ada = await person("ada@example.nl", "Ada's workspace");
      const credentials = {
        changePassword: async () => {
          throw new Error("must not run");
        },
        setPassword: async () => {
          throw new Error("must not run");
        },
        changeEmail: async () => {
          throw new Error("must not run");
        },
      };
      advance(RECENT_AUTHENTICATION_SECONDS * 1000 + 3000);

      expect(
        await auth.changePassword(
          ada.principal,
          { currentPassword: "current-passphrase", newPassword: "short" },
          credentials,
        ),
      ).toMatchObject({ ok: false, error: { kind: "invalid-input", field: "newPassword" } });
      expect(
        await auth.changePassword(
          ada.principal,
          { currentPassword: "", newPassword: "next-passphrase-1" },
          credentials,
        ),
      ).toMatchObject({ ok: false, error: { kind: "invalid-input", field: "currentPassword" } });
      expect(
        await auth.changePassword(
          { kind: "workspace", userId: ada.userId, workspaceId: ada.workspaceId, sessionId: "" },
          { currentPassword: "current-passphrase", newPassword: "next-passphrase-1" },
          credentials,
        ),
      ).toEqual({ ok: false, error: { kind: "invalid-credentials" } });
    });

    it("refuses a password change through a revoked or stale session", async () => {
      const ada = await person("ada@example.nl", "Ada's workspace");
      const changes: string[] = [];
      const credentials = {
        changePassword: async (input: { userId: string }) => {
          changes.push(input.userId);
        },
        setPassword: async () => {
          throw new Error("must not run");
        },
        changeEmail: async () => {
          throw new Error("must not run");
        },
      };

      await auth.revokeSession(ada.principal, { sessionId: ada.sessionId });
      expect(
        await auth.changePassword(
          ada.principal,
          { currentPassword: "current-passphrase", newPassword: "next-passphrase-1" },
          credentials,
        ),
      ).toEqual({ ok: false, error: { kind: "invalid-credentials" } });

      // A session past the absolute maximum cannot authorize a change either.
      const stale = await startSession(ada.userId);
      advance(SESSION_ABSOLUTE_SECONDS * 1000);
      expect(
        await auth.changePassword(
          principalForUser(
            ada.userId,
            { workspaceId: ada.workspaceId, role: "owner" },
            false,
            stale.sessionId,
          ),
          { currentPassword: "current-passphrase", newPassword: "next-passphrase-1" },
          credentials,
        ),
      ).toEqual({ ok: false, error: { kind: "invalid-credentials" } });
      expect(changes).toEqual([]);
    });

    it("does not let one account change another account's password", async () => {
      const ada = await person("ada@example.nl", "Ada's workspace");
      const sam = await person("sam@example.nl", "Sam's workspace");
      const credentials = {
        changePassword: async () => {
          throw new Error("must not run");
        },
        setPassword: async () => {
          throw new Error("must not run");
        },
        changeEmail: async () => {
          throw new Error("must not run");
        },
      };

      expect(
        await auth.changePassword(
          {
            kind: "workspace",
            userId: ada.userId,
            workspaceId: ada.workspaceId,
            sessionId: sam.sessionId,
          },
          { currentPassword: "current-passphrase", newPassword: "next-passphrase-1" },
          credentials,
        ),
      ).toEqual({ ok: false, error: { kind: "invalid-credentials" } });
    });

    it("requires recent authentication before an email change is confirmed", async () => {
      const ada = await person("ada@example.nl", "Ada's workspace");
      const requests: string[] = [];
      const links = {
        requestEmailChange: async (_principal: Principal, newEmail: string) => {
          requests.push(newEmail);
          return { ok: true as const, value: { confirmationSent: true as const } };
        },
      };

      advance(RECENT_AUTHENTICATION_SECONDS * 1000 + 3000);
      expect(
        await auth.changeEmail(ada.principal, { newEmail: "ada@example.com" }, links),
      ).toEqual({ ok: false, error: { kind: "reauthentication-required" } });
      expect(requests).toEqual([]);

      // Signing in again is what makes the change possible, and even then it
      // only sends the confirmation for the new address.
      const fresh = await startSession(ada.userId);
      expect(
        await auth.changeEmail(
          principalForUser(
            ada.userId,
            { workspaceId: ada.workspaceId, role: "owner" },
            false,
            fresh.sessionId,
          ),
          { newEmail: "ada@example.com" },
          links,
        ),
      ).toEqual({ ok: true, value: { confirmationSent: true } });
      expect(requests).toEqual(["ada@example.com"]);
    });
  });

  describe("sensitive credential creation", () => {
    it("requires recent authentication and the administrator role", async () => {
      const claimed = await auth.claimSetup(
        {
          token: TOKEN,
          name: "Ada Admin",
          email: "ada@example.nl",
          password: "correct-horse-battery",
          workspaceName: "Ada's workspace",
          sessionEstablished: true,
        },
        {
          createCredentialAccount: async ({ email, name }) => {
            await db("user").insert({ id: "user-ada", name, email, email_verified: false });
            return { userId: "user-ada" };
          },
          deleteIdentity: async () => undefined,
          verifyCredentials: async () => null,
        },
      );
      expect(claimed.ok).toBe(true);
      if (!claimed.ok) return;
      const session = await startSession("user-ada");
      const administrator = principalForUser(
        "user-ada",
        claimed.value.user.workspace,
        true,
        session.sessionId,
      );
      const shopper = await person("sam@example.nl", "Sam's workspace");
      const created: string[] = [];
      const provisioner = {
        createCredentialAccount: async ({ email }: { email: string }) => {
          created.push(email);
          return { userId: `user-${email}` };
        },
        deleteIdentity: async () => undefined,
        verifyCredentials: async () => null,
      };

      expect(
        await auth.createCredentialAccount(
          shopper.principal,
          { name: "New", email: "new@example.nl", password: "invited-passphrase" },
          provisioner,
        ),
      ).toEqual({ ok: false, error: { kind: "forbidden", capability: "installation.manage" } });

      advance(RECENT_AUTHENTICATION_SECONDS * 1000 + 3000);
      expect(
        await auth.createCredentialAccount(
          administrator,
          { name: "New", email: "new@example.nl", password: "invited-passphrase" },
          provisioner,
        ),
      ).toEqual({ ok: false, error: { kind: "reauthentication-required" } });
      expect(created).toEqual([]);

      // Signing in again makes the session recent enough for sensitive work.
      const recentSession = await startSession("user-ada");
      const recent = principalForUser(
        "user-ada",
        claimed.value.user.workspace,
        true,
        recentSession.sessionId,
      );
      expect(
        await auth.createCredentialAccount(
          recent,
          { name: "New", email: "New@Example.nl", password: "invited-passphrase" },
          provisioner,
        ),
      ).toEqual({ ok: true, value: { userId: "user-new@example.nl" } });
      expect(created).toEqual(["new@example.nl"]);

      expect(
        await auth.createCredentialAccount(
          recent,
          { name: "New", email: "not-an-email", password: "invited-passphrase" },
          provisioner,
        ),
      ).toMatchObject({ ok: false, error: { kind: "invalid-input", field: "email" } });
      expect(
        await auth.createCredentialAccount(
          recent,
          { name: "New", email: "x@example.nl", password: "short" },
          provisioner,
        ),
      ).toMatchObject({ ok: false, error: { kind: "invalid-input", field: "password" } });
      expect(created).toEqual(["new@example.nl"]);
    });

    it("still reports public registration as closed", async () => {
      expect(
        await auth.signUp(
          { name: "Mallory", email: "mallory@example.nl", sessionEstablished: true },
          fakeProvisioner(),
        ),
      ).toEqual({ ok: false, error: { kind: "registration-closed" } });
    });
  });
});
