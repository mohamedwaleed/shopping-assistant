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
import { createPasswordSetter } from "./account-links.ts";
import { createAuthServer } from "./auth-http.ts";
import { createIdentityStore } from "./identity.ts";
import { createRecordingMailer, type OutgoingEmail } from "./mailer.ts";

const AUTH_SECRET = "auth-secret-7d1f2b3c4e5a69788796a5b4c3d2e1f0";
const SETUP_TOKEN = "setup-token-0f9c1c1e4b6d4a51a2c3f0e5d7b8a9c6";
const PASSWORD = "correct-horse-battery-staple";
const NEW_PASSWORD = "another-horse-battery-staple";

interface ServedInstallation {
  database: Database;
  engine: Engine;
  auth: Auth;
  mailer: ReturnType<typeof createRecordingMailer>;
  origin: string;
  /** Replaces delivery, so a failing relay can be simulated. */
  deliverWith: (send: (message: OutgoingEmail) => Promise<void>) => void;
  close: () => Promise<void>;
}

let server: Database;

/**
 * An installation with registration closed, which is exactly the situation an
 * invitation exists for: the admin is signed in with a verified address and no
 * one else can join through sign-up.
 */
async function serveInstallation({
  registrationOpen = false,
  withMailer = true,
}: { registrationOpen?: boolean; withMailer?: boolean } = {}): Promise<ServedInstallation> {
  const { schema, drop } = await createTestSchema(server);
  const database = connectDatabase(withSearchPath(databaseUrlFromEnvironment(), schema));
  await migrate(database);
  const recording = createRecordingMailer();
  let deliver: (message: OutgoingEmail) => Promise<void> = async (message) => {
    await recording.send(message);
  };
  const mailer = {
    send: (message: OutgoingEmail) => deliver(message),
  };
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
    createUser: (...args: Parameters<ReturnType<typeof createIdentityStore>["createUser"]>) =>
      createIdentityStore(auth).createUser(...args),
    findUserByEmail: (email: string) => createIdentityStore(auth).findUserByEmail(email),
    revokeSessions: (identityId: string) =>
      createIdentityStore(auth).revokeSessions(identityId),
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
  engine = createEngine({
    database,
    setupToken: SETUP_TOKEN,
    identity,
    accounts: {
      passwords: createPasswordSetter(auth),
      ...(withMailer ? { email: { baseUrl: origin, mailer } } : {}),
    },
  });
  engineHolder.engine = engine;
  await engine.setup.complete({
    setupToken: SETUP_TOKEN,
    email: "operator@example.com",
    password: PASSWORD,
  });
  // The bootstrap admin holds no verification link to click, so the address it
  // was bootstrapped with counts as verified.
  await database("user").where({ email: "operator@example.com" }).update({ emailVerified: true });
  await database("installation").update({ registration_open: registrationOpen });

  return {
    database,
    engine,
    auth,
    mailer: recording,
    origin,
    deliverWith: (send) => {
      deliver = send;
    },
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
  return response.headers
    .getSetCookie()
    .join("; ")
    .split("; ")
    .filter((part) => part.includes("="))
    .map((part) => part.split(";")[0])
    .join("; ");
}

async function signIn(
  installation: ServedInstallation,
  email: string,
  password: string,
): Promise<Response> {
  return post(installation.origin, "/sign-in/email", { email, password });
}

async function adminCookie(installation: ServedInstallation): Promise<string> {
  return cookieFrom(await signIn(installation, "operator@example.com", PASSWORD));
}

function lastLinkTo(
  installation: ServedInstallation,
  recipient: string,
  path: string,
): URL {
  const message = installation.mailer.sent
    .filter((sent) => sent.to === recipient && sent.text.includes(path))
    .at(-1);
  if (!message) throw new Error(`No ${path} email was sent to ${recipient}`);
  const match = message.text.match(/https?:\/\/\S+/);
  if (!match?.[0]) throw new Error(`No link in the ${path} email`);
  return new URL(match[0]);
}

function tokenFrom(link: URL): string {
  const token = link.searchParams.get("token");
  if (!token) throw new Error("The link carries no token");
  return token;
}

beforeAll(() => {
  server = connectDatabase(databaseUrlFromEnvironment());
});

afterAll(async () => {
  await server?.destroy();
});

describe("admin invitations over HTTP", () => {
  it("turns an emailed invitation into an ordinary account while registration is closed", async () => {
    const installation = await serveInstallation({ registrationOpen: false });
    const issued = await post(
      installation.origin,
      "/invitations",
      { email: "invitee@example.com" },
      await adminCookie(installation),
    );
    const issuedBody = await issued.text();

    expect(issued.status).toBe(201);
    expect(JSON.parse(issuedBody)).toMatchObject({ email: "invitee@example.com" });
    const link = lastLinkTo(installation, "invitee@example.com", "/accept-invitation");
    const token = tokenFrom(link);
    // The admin who issued it must not be handed the credential it carries.
    expect(issuedBody).not.toContain(token);

    const described = await fetch(`${link.origin}${link.pathname}?token=${token}`);
    expect(described.status).toBe(200);
    expect(await described.json()).toMatchObject({ email: "invitee@example.com" });

    const accepted = await post(installation.origin, "/accept-invitation", {
      token,
      name: "Invitee",
      password: PASSWORD,
    });

    expect(accepted.status).toBe(201);
    expect(JSON.parse(await accepted.text())).toEqual({
      email: "invitee@example.com",
      role: "user",
    });
    expect(await installation.engine.accounts.findByEmail("invitee@example.com")).toMatchObject({
      role: "user",
    });
    // The link reached the inbox, so the invited account signs in without a
    // second verification email.
    expect((await signIn(installation, "invitee@example.com", PASSWORD)).status).toBe(200);
    await installation.close();
  });

  it("refuses an invitation requested without a session or by an ordinary account", async () => {
    const installation = await serveInstallation();
    const anonymous = await post(installation.origin, "/invitations", {
      email: "friend@example.com",
    });

    const admin = await adminCookie(installation);
    await post(installation.origin, "/invitations", { email: "shopper@example.com" }, admin);
    const shopperToken = tokenFrom(
      lastLinkTo(installation, "shopper@example.com", "/accept-invitation"),
    );
    await post(installation.origin, "/accept-invitation", {
      token: shopperToken,
      name: "Shopper",
      password: PASSWORD,
    });
    const shopper = await signIn(installation, "shopper@example.com", PASSWORD);
    const byShopper = await post(
      installation.origin,
      "/invitations",
      { email: "friend@example.com" },
      cookieFrom(shopper),
    );

    expect(anonymous.status).toBe(401);
    expect(byShopper.status).toBe(403);
    expect(JSON.parse(await byShopper.text())).toEqual({ error: "Only an admin may invite someone" });
    await installation.close();
  });

  it("refuses a replayed, tampered, or expired invitation link with one explicit answer", async () => {
    const installation = await serveInstallation();
    const admin = await adminCookie(installation);
    await post(installation.origin, "/invitations", { email: "invitee@example.com" }, admin);
    const link = lastLinkTo(installation, "invitee@example.com", "/accept-invitation");
    const token = tokenFrom(link);

    const accepted = await post(installation.origin, "/accept-invitation", {
      token,
      name: "Invitee",
      password: PASSWORD,
    });
    const replayed = await post(installation.origin, "/accept-invitation", {
      token,
      name: "Replay",
      password: PASSWORD,
    });
    const tampered = await post(installation.origin, "/accept-invitation", {
      token: `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`,
      name: "Tampered",
      password: PASSWORD,
    });
    const unknown = await post(installation.origin, "/accept-invitation", {
      token: "never-issued-by-this-installation",
      name: "Stranger",
      password: PASSWORD,
    });

    expect(accepted.status).toBe(201);
    for (const refusal of [replayed, tampered, unknown]) {
      expect(refusal.status).toBe(410);
      expect(await refusal.text()).toBe(
        JSON.stringify({ error: "The invitation link is invalid, expired, or already used" }),
      );
    }
    // An expired link is refused the same way rather than naming its state.
    await installation.database("invitations").update({ expires_at: new Date(0) });
    const expiredLink = await fetch(`${link.origin}${link.pathname}?token=${token}`);
    expect(expiredLink.status).toBe(410);
    await installation.close();
  });

  it("lets only one of two simultaneous acceptances create the account", async () => {
    const installation = await serveInstallation();
    await post(
      installation.origin,
      "/invitations",
      { email: "invitee@example.com" },
      await adminCookie(installation),
    );
    const token = tokenFrom(lastLinkTo(installation, "invitee@example.com", "/accept-invitation"));
    const accept = (name: string) =>
      post(installation.origin, "/accept-invitation", { token, name, password: PASSWORD }).then(
        (response) => response.status,
      );

    const statuses = await Promise.all([accept("One"), accept("Two")]);

    expect(statuses.sort()).toEqual([201, 410]);
    expect(await installation.database("profiles").where({ email: "invitee@example.com" })).toHaveLength(
      1,
    );
    await installation.close();
  });

  it("answers an undeliverable invitation explicitly, without a token", async () => {
    const installation = await serveInstallation();
    const admin = await adminCookie(installation);
    installation.deliverWith(async () => {
      throw new Error("relay refused the message");
    });

    const response = await post(installation.origin, "/invitations", { email: "invitee@example.com" }, admin);
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).not.toContain("relay refused");
    expect(await installation.database("invitations")).toHaveLength(0);
    await installation.close();
  });

  it("answers an invitation request on an installation without SMTP explicitly", async () => {
    const installation = await serveInstallation({ withMailer: false });

    const response = await post(
      installation.origin,
      "/invitations",
      { email: "invitee@example.com" },
      await adminCookie(installation),
    );

    expect(response.status).toBe(503);
    expect(await response.text()).toContain("Email is not configured");
    await installation.close();
  });
});

describe("password reset over HTTP", () => {
  it("replaces the password through the emailed link, so only the new one signs in", async () => {
    const installation = await serveInstallation({ registrationOpen: true });
    await post(installation.origin, "/sign-up/email", {
      name: "Shopper",
      email: "shopper@example.com",
      password: PASSWORD,
    });
    await fetch(lastLinkTo(installation, "shopper@example.com", "/verify-email"), {
      redirect: "manual",
    });
    const signedIn = await signIn(installation, "shopper@example.com", PASSWORD);
    const before = cookieFrom(signedIn);

    const requested = await post(installation.origin, "/request-password-reset", {
      email: "shopper@example.com",
    });
    expect(requested.status).toBe(202);
    const link = lastLinkTo(installation, "shopper@example.com", "/reset-password");
    const token = tokenFrom(link);
    expect(await requested.text()).not.toContain(token);

    const described = await fetch(`${link.origin}${link.pathname}?token=${token}`);
    expect(described.status).toBe(200);

    const completed = await post(installation.origin, "/reset-password", {
      token,
      password: NEW_PASSWORD,
    });
    const completedBody = await completed.text();

    expect(completed.status).toBe(200);
    expect(completedBody).not.toContain(NEW_PASSWORD);
    expect(completedBody).not.toContain(token);
    expect((await signIn(installation, "shopper@example.com", PASSWORD)).status).toBe(401);
    expect((await signIn(installation, "shopper@example.com", NEW_PASSWORD)).status).toBe(200);
    // Whoever held the old password could have held a session with it.
    const session = await fetch(`${installation.origin}/api/auth/get-session`, {
      headers: { cookie: before, origin: installation.origin },
    });
    expect(await session.json()).toBeNull();
    await installation.close();
  });

  it("answers a known and an unknown address identically and sends only to the known one", async () => {
    const installation = await serveInstallation({ registrationOpen: true });
    await post(installation.origin, "/sign-up/email", {
      name: "Shopper",
      email: "shopper@example.com",
      password: PASSWORD,
    });

    const known = await post(installation.origin, "/request-password-reset", {
      email: "shopper@example.com",
    });
    const unknown = await post(installation.origin, "/request-password-reset", {
      email: "nobody@example.com",
    });

    expect(known.status).toBe(unknown.status);
    expect(await known.text()).toBe(await unknown.text());
    expect(installation.mailer.sent.filter((sent) => sent.text.includes("/reset-password"))).toHaveLength(
      1,
    );
    await installation.close();
  });

  it("refuses a replayed, unknown, or expired reset link with one explicit answer", async () => {
    const installation = await serveInstallation({ registrationOpen: true });
    await post(installation.origin, "/sign-up/email", {
      name: "Shopper",
      email: "shopper@example.com",
      password: PASSWORD,
    });
    // Sign-in needs a verified address, and the password change is what this
    // test checks, so the link is followed rather than the row patched.
    await fetch(lastLinkTo(installation, "shopper@example.com", "/verify-email"), {
      redirect: "manual",
    });
    await post(installation.origin, "/request-password-reset", { email: "shopper@example.com" });
    const token = tokenFrom(lastLinkTo(installation, "shopper@example.com", "/reset-password"));

    expect(
      (await post(installation.origin, "/reset-password", { token, password: NEW_PASSWORD })).status,
    ).toBe(200);
    const replayed = await post(installation.origin, "/reset-password", {
      token,
      password: PASSWORD,
    });
    const unknown = await post(installation.origin, "/reset-password", {
      token: "never-issued-by-this-installation",
      password: PASSWORD,
    });

    for (const refusal of [replayed, unknown]) {
      expect(refusal.status).toBe(410);
      expect(await refusal.text()).toBe(
        JSON.stringify({ error: "The reset link is invalid, expired, or already used" }),
      );
    }

    await post(installation.origin, "/request-password-reset", { email: "shopper@example.com" });
    const expiredToken = tokenFrom(
      lastLinkTo(installation, "shopper@example.com", "/reset-password"),
    );
    await installation.database("verification").update({ expiresAt: new Date(0) });
    const expired = await post(installation.origin, "/reset-password", {
      token: expiredToken,
      password: PASSWORD,
    });
    expect(expired.status).toBe(410);
    expect((await signIn(installation, "shopper@example.com", NEW_PASSWORD)).status).toBe(200);
    await installation.close();
  });

  it("lets only one of two simultaneous completions set a password", async () => {
    const installation = await serveInstallation({ registrationOpen: true });
    await post(installation.origin, "/sign-up/email", {
      name: "Shopper",
      email: "shopper@example.com",
      password: PASSWORD,
    });
    await post(installation.origin, "/request-password-reset", { email: "shopper@example.com" });
    const token = tokenFrom(lastLinkTo(installation, "shopper@example.com", "/reset-password"));
    const complete = (password: string) =>
      post(installation.origin, "/reset-password", { token, password }).then(
        (response) => response.status,
      );

    const statuses = await Promise.all([complete(NEW_PASSWORD), complete("third-password-value")]);

    expect(statuses.sort()).toEqual([200, 410]);
    await installation.close();
  });

  it("answers a reset request on an installation without SMTP explicitly", async () => {
    const installation = await serveInstallation({ registrationOpen: true, withMailer: false });

    const response = await post(installation.origin, "/request-password-reset", {
      email: "operator@example.com",
    });

    expect(response.status).toBe(503);
    expect(await response.text()).toContain("Email is not configured");
    await installation.close();
  });
});
