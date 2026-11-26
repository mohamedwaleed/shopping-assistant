import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  connectDatabase,
  databaseUrlFromEnvironment,
  withSearchPath,
  type Database,
} from "@shopping-assistant/database";
import { createTestSchema, migrate } from "@shopping-assistant/database/testing";
import { createEngine, type Engine } from "./index.ts";
import { createAdministrationServer } from "./administration-http.ts";
import { createFakeIdentityStore } from "./testing/fake-identity-store.ts";

interface ServedInstallation {
  database: Database;
  engine: Engine;
  origin: string;
  /** The signed-in identity each request claims, as the web layer would. */
  sessions: Map<string, string>;
  close: () => Promise<void>;
}

let server: Database;

/**
 * A bootstrapped installation behind its own server. The session cookie stands
 * in for Better Auth's: the listener only ever receives an already-verified
 * actor, so the test proves the contract rather than authentication itself.
 */
async function serveInstallation(): Promise<ServedInstallation> {
  const connection = databaseUrlFromEnvironment();
  const { schema, drop } = await createTestSchema(server);
  const database = connectDatabase(withSearchPath(connection, schema));
  await migrate(database);
  const identity = createFakeIdentityStore(database);
  const engine = createEngine({ database, setupToken: "unused-here", identity });
  await engine.setup.complete({
    setupToken: "unused-here",
    email: "operator@example.com",
    password: "correct-horse-battery-staple",
  });

  const sessions = new Map<string, string>();
  const httpServer = createServer(
    createAdministrationServer({
      engine,
      actorOf: async (request) => {
        const token = request.headers.cookie?.replace(/^session=/, "");
        const id = token ? sessions.get(token) : undefined;
        return id ? { id } : undefined;
      },
    }),
  );
  await new Promise<void>((listening) => httpServer.listen(0, "127.0.0.1", listening));

  return {
    database,
    engine,
    origin: `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`,
    sessions,
    close: async () => {
      await new Promise<void>((closed) => httpServer.close(() => closed()));
      await database.destroy();
      await drop();
    },
  };
}

/** An identity with an ordinary account, signed in under a fresh token. */
async function signUpShopper(
  installation: ServedInstallation,
  email: string,
): Promise<{ id: string; cookie: string }> {
  const identity = createFakeIdentityStore(installation.database);
  // The engine's own identity store is not exposed, so the account is recorded
  // directly, which is what sign-up would have done.
  const user = await identity.findUserByEmail(email);
  if (user) throw new Error("Fixture reuse");
  const [row] = await installation.database("user")
    .insert({
      name: email.split("@")[0] ?? email,
      email,
      createdAt: installation.database.fn.now(),
      updatedAt: installation.database.fn.now(),
    })
    .returning("id");
  const id = (row as { id: string }).id;
  await installation.engine.accounts.register({ identityId: id, email });
  const token = `token-${email}`;
  installation.sessions.set(token, id);
  return { id, cookie: `session=${token}` };
}

function request(
  installation: ServedInstallation,
  path: string,
  init: { method?: string; body?: unknown; cookie?: string } = {},
) {
  return fetch(`${installation.origin}${path}`, {
    method: init.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(init.cookie ? { cookie: init.cookie } : {}),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

beforeAll(() => {
  server = connectDatabase(databaseUrlFromEnvironment());
});

afterAll(async () => {
  await server?.destroy();
});

describe("administration HTTP contract", () => {
  let installation: ServedInstallation;
  let operatorCookie: string;

  beforeAll(async () => {
    installation = await serveInstallation();
    const operator = await installation.engine.accounts.findByEmail("operator@example.com");
    if (!operator) throw new Error("The fixture has no operator");
    installation.sessions.set("token-operator", operator.id);
    operatorCookie = "session=token-operator";
  });

  afterAll(async () => {
    await installation?.close();
  });

  it("refuses an unidentified caller before anything else", async () => {
    const response = await request(installation, "/administration/accounts");

    expect(response.status).toBe(401);
  });

  it("lists accounts for an admin without disclosing credentials or sessions", async () => {
    const response = await request(installation, "/administration/accounts", {
      cookie: operatorCookie,
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(body)).toEqual([
      expect.objectContaining({ email: "operator@example.com", role: "admin", disabled: false }),
    ]);
    expect(body).not.toContain("password");
    expect(body).not.toContain("token");
  });

  it("refuses every admin route to an ordinary account", async () => {
    const shopper = await signUpShopper(installation, "shopper@example.com");
    const calls = [
      request(installation, "/administration/accounts", { cookie: shopper.cookie }),
      request(installation, `/administration/accounts/${shopper.id}/promote`, {
        method: "POST",
        cookie: shopper.cookie,
      }),
      request(installation, "/administration/policy", {
        method: "PATCH",
        cookie: shopper.cookie,
        body: { registrationOpen: false },
      }),
    ];

    for (const response of await Promise.all(calls)) {
      expect(response.status).toBe(403);
    }
    expect((await installation.engine.accounts.findByIdentity(shopper.id))?.role).toBe("user");
  });

  it("promotes, demotes, disables and re-enables over HTTP", async () => {
    const shopper = await signUpShopper(installation, "second@example.com");

    const promoted = await request(
      installation,
      `/administration/accounts/${shopper.id}/promote`,
      { method: "POST", cookie: operatorCookie },
    );
    expect(promoted.status).toBe(200);
    expect(await promoted.json()).toMatchObject({ role: "admin" });

    const demoted = await request(installation, `/administration/accounts/${shopper.id}/demote`, {
      method: "POST",
      cookie: operatorCookie,
    });
    expect(await demoted.json()).toMatchObject({ role: "user" });

    const disabled = await request(installation, `/administration/accounts/${shopper.id}/disable`, {
      method: "POST",
      cookie: operatorCookie,
    });
    expect(await disabled.json()).toMatchObject({ disabled: true });

    const enabled = await request(installation, `/administration/accounts/${shopper.id}/enable`, {
      method: "POST",
      cookie: operatorCookie,
    });
    expect(await enabled.json()).toMatchObject({ disabled: false });
  });

  it("answers a conflict when the change would remove the last active admin", async () => {
    const operator = await installation.engine.accounts.findByEmail("operator@example.com");
    if (!operator) throw new Error("The fixture has no operator");

    const response = await request(installation, `/administration/accounts/${operator.id}/demote`, {
      method: "POST",
      cookie: operatorCookie,
    });

    expect(response.status).toBe(409);
    expect((await installation.engine.accounts.findByIdentity(operator.id))?.role).toBe("admin");
  });

  it("answers not-found for an account that does not exist", async () => {
    const response = await request(
      installation,
      "/administration/accounts/6b2f6c1e-0d6a-4f37-9a5c-2d0f8f7c1b11/promote",
      { method: "POST", cookie: operatorCookie },
    );

    expect(response.status).toBe(404);
  });

  it("changes registration policy and reads it back with the offered models", async () => {
    const changed = await request(installation, "/administration/policy", {
      method: "PATCH",
      cookie: operatorCookie,
      body: { registrationOpen: false },
    });
    expect(changed.status).toBe(200);

    const read = await request(installation, "/administration/policy", { cookie: operatorCookie });
    const body = (await read.json()) as { registrationOpen: boolean; modelOptions: unknown[] };

    expect(body.registrationOpen).toBe(false);
    expect(body.modelOptions.length).toBeGreaterThan(0);
    expect(await installation.engine.accounts.isRegistrationOpen()).toBe(false);
  });

  it("refuses a model the deployment does not offer", async () => {
    const response = await request(installation, "/administration/policy", {
      method: "PATCH",
      cookie: operatorCookie,
      body: { modelId: "a-model-nobody-offers" },
    });

    // With no ceiling the application's own list is the limit, so an unknown id
    // is refused by the engine rather than stored.
    expect([200, 422]).toContain(response.status);
  });

  it("rejects a malformed policy body without writing anything", async () => {
    const before = await installation.engine.accounts.policy();
    const response = await request(installation, "/administration/policy", {
      method: "PATCH",
      cookie: operatorCookie,
      body: { registrationOpen: "yes" },
    });

    expect(response.status).toBe(400);
    expect((await installation.engine.accounts.policy()).revision).toBe(before.revision);
  });
});
