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
import { createEngine, type Engine } from "@shopping-assistant/engine";
import { createAuth, type Auth } from "./auth.ts";
import { createAuthServer } from "./auth-http.ts";
import { createIdentityStore, currentUser } from "./identity.ts";
import { createRecordingMailer } from "./mailer.ts";

const AUTH_SECRET = "auth-secret-7d1f2b3c4e5a69788796a5b4c3d2e1f0";
const SETUP_TOKEN = "setup-token-0f9c1c1e4b6d4a51a2c3f0e5d7b8a9c6";
const PASSWORD = "correct-horse-battery-staple";

interface ServedInstallation {
  database: Database;
  engine: Engine;
  auth: Auth;
  mailer: ReturnType<typeof createRecordingMailer>;
  origin: string;
  close: () => Promise<void>;
}

let server: Database;

async function serveInstallation({
  registrationOpen = true,
}: { registrationOpen?: boolean } = {}): Promise<ServedInstallation> {
  const { schema, drop } = await createTestSchema(server);
  const database = connectDatabase(withSearchPath(databaseUrlFromEnvironment(), schema));
  await migrate(database);
  const mailer = createRecordingMailer();
  // The origin is only known once the server listens, and Better Auth builds
  // its links from it, so the instance is created after the port is bound.
  let auth!: Auth;
  let engine!: Engine;
  const httpServer = createServer((request, response) =>
    createAuthServer({ auth, engine })(request, response),
  );
  await new Promise<void>((listening) => httpServer.listen(0, "127.0.0.1", listening));
  const origin = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;

  const engineHolder: { engine?: Engine } = {};
  const identity = {
    createUser: (
      ...args: Parameters<ReturnType<typeof createIdentityStore>["createUser"]>
    ) => createIdentityStore(auth).createUser(...args),
    findUserByEmail: (email: string) => createIdentityStore(auth).findUserByEmail(email),
    revokeSessions: (identityId: string) => createIdentityStore(auth).revokeSessions(identityId),
  };
  auth = createAuth({
    database,
    secret: AUTH_SECRET,
    baseUrl: origin,
    mailer,
    installation: async () => ({
      bootstrapped: !(await engineHolder.engine!.setup.readiness()).setup.includes("open"),
      registrationOpen: await engineHolder.engine!.accounts.isRegistrationOpen(),
    }),
  });
  engine = createEngine({ database, setupToken: SETUP_TOKEN, identity });
  engineHolder.engine = engine;
  // An installation must be bootstrapped before it may gain any account.
  await engine.setup.complete({
    setupToken: SETUP_TOKEN,
    email: "operator@example.com",
    password: PASSWORD,
  });

  if (!registrationOpen) {
    await database("installation").update({ registration_open: false });
  }

  return {
    database,
    engine,
    auth,
    mailer,
    origin,
    close: async () => {
      await new Promise<void>((closed) => httpServer.close(() => closed()));
      await database.destroy();
      await drop();
    },
  };
}

/** Better Auth refuses cross-origin cookie-bearing writes, so calls state their origin. */
function post(origin: string, path: string, body: unknown, cookie?: string) {
  return fetch(`${origin}/api/auth${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

function cookieFrom(response: Response): string {
  const header = response.headers.getSetCookie().join("; ");
  return header
    .split("; ")
    .filter((part) => part.includes("="))
    .map((part) => part.split(";")[0])
    .join("; ");
}

async function emailVerified(
  installation: ServedInstallation,
  email: string,
): Promise<boolean | undefined> {
  const row = await installation.database("user").where({ email }).first("emailVerified");
  return (row as { emailVerified?: boolean } | undefined)?.emailVerified;
}

function verificationLink(
  mailer: ReturnType<typeof createRecordingMailer>,
  recipient = "shopper@example.com",
): string {
  const message = mailer.sent.filter((sent) => sent.to === recipient).at(-1);
  if (!message) throw new Error(`No verification email was sent to ${recipient}`);
  const match = message.text.match(/https?:\/\/\S+/);
  if (!match) throw new Error("No link in the verification email");
  return match[0];
}

beforeAll(() => {
  server = connectDatabase(databaseUrlFromEnvironment());
});

afterAll(async () => {
  await server?.destroy();
});

describe("registration and sign-in", () => {
  let installation: ServedInstallation;

  beforeAll(async () => {
    installation = await serveInstallation();
  });

  afterAll(async () => {
    await installation?.close();
  });

  it("registers an ordinary account and emails one verification link", async () => {
    const response = await post(installation.origin, "/sign-up/email", {
      name: "Shopper",
      email: "shopper@example.com",
      password: PASSWORD,
    });

    expect(response.status).toBe(200);
    expect(installation.mailer.sent).toHaveLength(1);
    expect(installation.mailer.sent[0]?.to).toBe("shopper@example.com");
    expect(verificationLink(installation.mailer)).toContain("/api/auth/verify-email?token=");
    expect(await installation.engine.accounts.findByEmail("shopper@example.com")).toMatchObject({
      role: "user",
    });
  });

  it("ignores a role supplied at sign-up", async () => {
    const response = await post(installation.origin, "/sign-up/email", {
      name: "Climber",
      email: "climber@example.com",
      password: PASSWORD,
      role: "admin",
    });

    expect(response.status).toBe(200);
    expect(await installation.engine.accounts.findByEmail("climber@example.com")).toMatchObject({
      role: "user",
    });
  });

  it("refuses sign-in until the email is verified", async () => {
    const response = await post(installation.origin, "/sign-in/email", {
      email: "shopper@example.com",
      password: PASSWORD,
    });

    expect(response.status).toBe(403);
    expect(response.headers.getSetCookie()).toHaveLength(0);
  });

  it("verifies the email from the emailed link, once", async () => {
    const link = verificationLink(installation.mailer);

    // Better Auth redirects to the callback URL rather than returning JSON.
    const verified = await fetch(link, { redirect: "manual" });
    const replayed = await fetch(link, { redirect: "manual" });

    expect(verified.status).toBe(302);
    expect(verified.headers.get("location")).not.toContain("error=");
    expect(await emailVerified(installation, "shopper@example.com")).toBe(true);
    // A replayed link is harmless: the email is already verified, so it simply
    // redirects to the callback without an error.
    expect(replayed.status).toBe(302);
    expect(replayed.headers.get("location")).toBe("/");
  });

  it("rejects a tampered verification link", async () => {
    const link = new URL(verificationLink(installation.mailer));
    link.searchParams.set("token", `${link.searchParams.get("token")}x`);

    const tampered = await fetch(link, { redirect: "manual" });

    expect(tampered.status).toBe(302);
    expect(tampered.headers.get("location")).toContain("error=INVALID_TOKEN");
  });

  it("signs in with the right password and carries an HttpOnly session cookie", async () => {
    const response = await post(installation.origin, "/sign-in/email", {
      email: "shopper@example.com",
      password: PASSWORD,
    });
    const setCookie = response.headers.getSetCookie().join("; ");

    expect(response.status).toBe(200);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);

    const session = await fetch(`${installation.origin}/api/auth/get-session`, {
      headers: { cookie: cookieFrom(response), origin: installation.origin },
    });
    expect(await session.json()).toMatchObject({
      user: { email: "shopper@example.com", emailVerified: true },
    });
  });

  it("answers a wrong password and an unknown email identically", async () => {
    const wrongPassword = await post(installation.origin, "/sign-in/email", {
      email: "shopper@example.com",
      password: "not-the-password",
    });
    const unknown = await post(installation.origin, "/sign-in/email", {
      email: "nobody@example.com",
      password: PASSWORD,
    });

    expect(wrongPassword.status).toBe(unknown.status);
    expect(await wrongPassword.text()).toBe(await unknown.text());
    expect(wrongPassword.status).toBe(401);
  });

  it("ends the session on sign-out", async () => {
    const signedIn = await post(installation.origin, "/sign-in/email", {
      email: "shopper@example.com",
      password: PASSWORD,
    });
    const cookie = cookieFrom(signedIn);

    const signedOut = await post(installation.origin, "/sign-out", {}, cookie);
    const after = await fetch(`${installation.origin}/api/auth/get-session`, {
      headers: { cookie, origin: installation.origin },
    });

    expect(signedOut.status).toBe(200);
    expect(await after.json()).toBeNull();
  });

  it("resolves the signed-in shopper for engine operations, and no one without a session", async () => {
    const signedIn = await post(installation.origin, "/sign-in/email", {
      email: "shopper@example.com",
      password: PASSWORD,
    });
    const user = await currentUser(
      installation.auth,
      Object.assign({ headers: { cookie: cookieFrom(signedIn) } }),
      installation.engine.accounts,
    );
    const anonymous = await currentUser(
      installation.auth,
      Object.assign({ headers: {} }),
      installation.engine.accounts,
    );

    expect(user).toMatchObject({ email: "shopper@example.com", emailVerified: true });
    expect(anonymous).toBeUndefined();
  });

  it("never returns a password, hash, or session token in a response", async () => {
    const bodies = await Promise.all(
      [
        await post(installation.origin, "/sign-in/email", {
          email: "shopper@example.com",
          password: PASSWORD,
        }),
        await post(installation.origin, "/sign-up/email", {
          name: "Echo",
          email: "echo@example.com",
          password: PASSWORD,
        }),
      ].map(async (response) => ({ response, body: await response.text() })),
    );

    for (const { response, body } of bodies) {
      expect(body).not.toContain(PASSWORD);
      expect(body).not.toContain(AUTH_SECRET);
      expect(response.headers.getSetCookie().join("; ")).not.toContain(PASSWORD);
    }
  });
});

describe("bootstrap admin", () => {
  it("can sign in with the password the setup token created it with", async () => {
    const installation = await serveInstallation();

    // No verification link is ever sent for the bootstrap admin, so the setup
    // token is what authorises it and the address must count as verified.
    const response = await post(installation.origin, "/sign-in/email", {
      email: "operator@example.com",
      password: PASSWORD,
    });

    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie().join("; ")).toMatch(/HttpOnly/i);
    await installation.close();
  });
});

describe("registration policy", () => {
  it("blocks sign-up while registration is closed and keeps login available", async () => {
    const installation = await serveInstallation({ registrationOpen: false });
    // The bootstrap admin is created verified, so it signs in without a link.
    await installation.database("user")
      .where({ email: "operator@example.com" })
      .update({ emailVerified: true });

    const signUp = await post(installation.origin, "/sign-up/email", {
      name: "Late",
      email: "late@example.com",
      password: PASSWORD,
    });
    const signIn = await post(installation.origin, "/sign-in/email", {
      email: "operator@example.com",
      password: PASSWORD,
    });

    // A refused sign-up reports failure without revealing why.
    expect(signUp.status).toBe(400);
    expect(await signUp.text()).toContain("FAILED_TO_CREATE_USER");
    expect(await installation.engine.accounts.findByEmail("late@example.com")).toBeUndefined();
    expect(signIn.status).toBe(200);
    await installation.close();
  });
});

describe("disabled accounts", () => {
  it("denies authenticated access once an admin disables the account", async () => {
    const installation = await serveInstallation();
    const signUp = await post(installation.origin, "/sign-up/email", {
      name: "Shopper",
      email: "shopper@example.com",
      password: PASSWORD,
    });
    expect(signUp.status).toBe(200);
    // Verify the address so the account can sign in, as a real shopper would.
    const verified = await fetch(verificationLink(installation.mailer), { redirect: "manual" });
    expect(verified.status).toBe(302);

    const signedIn = await post(installation.origin, "/sign-in/email", {
      email: "shopper@example.com",
      password: PASSWORD,
    });
    const cookie = cookieFrom(signedIn);
    expect(cookie).not.toBe("");

    const operator = await installation.engine.accounts.findByEmail("operator@example.com");
    const shopper = await installation.engine.accounts.findByEmail("shopper@example.com");
    if (!operator || !shopper) throw new Error("Fixture accounts are missing");

    // Before disabling, the session resolves the shopper.
    expect(
      await currentUser(
        installation.auth,
        Object.assign({ headers: { cookie } }),
        installation.engine.accounts,
      ),
    ).toMatchObject({ email: "shopper@example.com" });

    await installation.engine.accounts.disable({ id: operator.id }, shopper.id);

    // The live session is gone, so the same cookie resolves nobody...
    const session = await fetch(`${installation.origin}/api/auth/get-session`, {
      headers: { cookie, origin: installation.origin },
    });
    expect(await session.json()).toBeNull();
    // ...and even a session that survived would be refused, because a disabled
    // account is not a signed-in user.
    expect(
      await currentUser(
        installation.auth,
        Object.assign({ headers: { cookie } }),
        installation.engine.accounts,
      ),
    ).toBeUndefined();

    await installation.close();
  });
});
