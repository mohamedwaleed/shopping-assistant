import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  connectDatabase,
  databaseUrlFromEnvironment,
  withSearchPath,
  type Database,
} from "@shopping-assistant/database";
import { createTestSchema, listAccounts, migrate } from "@shopping-assistant/database/testing";
import { createEngine } from "./index.ts";
import { createSetupServer } from "./setup-http.ts";
import { createFakeIdentityStore } from "./testing/fake-identity-store.ts";

const SETUP_TOKEN = "setup-token-0f9c1c1e4b6d4a51a2c3f0e5d7b8a9c6";
const PASSWORD = "correct-horse-battery-staple";

interface ServedInstallation {
  database: Database;
  origin: string;
  close: () => Promise<void>;
}

let server: Database;

/** A fresh installation behind its own HTTP server, because setup closes once. */
async function serveInstallation(): Promise<ServedInstallation> {
  const connection = databaseUrlFromEnvironment();
  const { schema, drop } = await createTestSchema(server);
  const database = connectDatabase(withSearchPath(connection, schema));
  await migrate(database);
  const httpServer = createServer(
    createSetupServer({
      engine: createEngine({
        database,
        setupToken: SETUP_TOKEN,
        identity: createFakeIdentityStore(database),
      }),
    }),
  );
  await new Promise<void>((listening) => httpServer.listen(0, "127.0.0.1", listening));
  return {
    database,
    origin: `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`,
    close: async () => {
      await new Promise<void>((closed) => httpServer.close(() => closed()));
      await database.destroy();
      await drop();
    },
  };
}

beforeAll(() => {
  server = connectDatabase(databaseUrlFromEnvironment());
});

afterAll(async () => {
  await server?.destroy();
});

describe("setup HTTP contract", () => {
  let installation: ServedInstallation;
  let database: Database;
  let origin: string;

  beforeAll(async () => {
    installation = await serveInstallation();
    database = installation.database;
    origin = installation.origin;
  });

  afterAll(async () => {
    await installation?.close();
  });

  it("reports readiness without disclosing the setup token", async () => {
    const response = await fetch(`${origin}/setup`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(body)).toEqual({
      database: "ready",
      email: "unconfigured",
      model: "unconfigured",
      discovery: "unconfigured",
      setup: "open",
    });
    expect(body).not.toContain(SETUP_TOKEN);
  });

  it("rejects a bootstrap request whose token is wrong, and keeps it out of the response", async () => {
    const submitted = "wrong-token-7c2d1b9a8f4e4d3c2b1a0f9e8d7c6b5a";
    const response = await fetch(`${origin}/setup/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        setupToken: submitted,
        email: "intruder@example.com",
        password: PASSWORD,
      }),
    });
    const body = await response.text();

    expect(response.status).toBe(403);
    expect(body).not.toContain(submitted);
    expect(body).not.toContain(SETUP_TOKEN);
  });

  it("creates the initial admin and then refuses a replay over HTTP", async () => {
    const bootstrap = () =>
      fetch(`${origin}/setup/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          setupToken: SETUP_TOKEN,
          email: "operator@example.com",
          password: PASSWORD,
        }),
      });

    const created = await bootstrap();
    const createdBody = await created.text();
    const replayed = await bootstrap();

    expect(created.status).toBe(201);
    expect(JSON.parse(createdBody)).toEqual({ email: "operator@example.com", role: "admin" });
    expect(createdBody).not.toContain(SETUP_TOKEN);
    expect(replayed.status).toBe(409);
    expect(JSON.parse(await (await fetch(`${origin}/setup`)).text()).setup).toBe("closed");
  });

  it("answers two simultaneous bootstrap requests with one admin and one conflict", async () => {
    const fresh = await serveInstallation();
    const bootstrap = (email: string) =>
      fetch(`${fresh.origin}/setup/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ setupToken: SETUP_TOKEN, email, password: PASSWORD }),
      }).then((response) => response.status);

    const statuses = await Promise.all([
      bootstrap("first@example.com"),
      bootstrap("second@example.com"),
    ]);

    expect(statuses.sort()).toEqual([201, 409]);
    const accounts = await listAccounts(fresh.database);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.role).toBe("admin");
    await fresh.close();
  });
});
