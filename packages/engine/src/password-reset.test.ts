import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  connectDatabase,
  databaseUrlFromEnvironment,
  withSearchPath,
  type Database,
} from "@shopping-assistant/database";
import { createTestSchema, migrate } from "@shopping-assistant/database/testing";
import {
  createEngine,
  EmailUnavailableError,
  ResetTokenInvalidError,
  type Engine,
} from "./index.ts";
import { createFakeIdentityStore } from "./testing/fake-identity-store.ts";

const SETUP_TOKEN = "setup-token-0f9c1c1e4b6d4a51a2c3f0e5d7b8a9c6";
const BASE_URL = "https://shopping.example";
const PASSWORD = "correct-horse-battery-staple";
const NEW_PASSWORD = "another-horse-battery-staple";

let server: Database;

interface Outgoing {
  to: string;
  subject: string;
  text: string;
}

interface Installation {
  database: Database;
  engine: Engine;
  sent: Outgoing[];
  /** Every password the engine asked to be written, in order. */
  written: { identityId: string; password: string }[];
  advance: (milliseconds: number) => void;
  deliverWith: (send: (message: Outgoing) => Promise<void>) => void;
  drop: () => Promise<void>;
}

async function createInstallation({
  withMailer = true,
}: { withMailer?: boolean } = {}): Promise<Installation> {
  const { schema, drop } = await createTestSchema(server);
  const database = connectDatabase(withSearchPath(databaseUrlFromEnvironment(), schema));
  await migrate(database);
  const sent: Outgoing[] = [];
  const written: { identityId: string; password: string }[] = [];
  const clock = { now: new Date("2026-03-01T09:00:00.000Z") };
  let deliver = async (message: Outgoing) => {
    sent.push(message);
  };
  const engine = createEngine({
    database,
    setupToken: SETUP_TOKEN,
    identity: createFakeIdentityStore(),
    accounts: {
      passwords: {
        async setPassword(identityId, password) {
          written.push({ identityId, password });
        },
      },
      ...(withMailer
        ? { email: { baseUrl: BASE_URL, mailer: { send: (message: Outgoing) => deliver(message) } } }
        : {}),
    },
    now: () => clock.now,
  });
  await engine.setup.complete({
    setupToken: SETUP_TOKEN,
    email: "operator@example.com",
    password: PASSWORD,
  });
  return {
    database,
    engine,
    sent,
    written,
    advance: (milliseconds) => {
      clock.now = new Date(clock.now.getTime() + milliseconds);
    },
    deliverWith: (send) => {
      deliver = send;
    },
    drop,
  };
}

async function discard({ database, drop }: Installation): Promise<void> {
  await database.destroy();
  await drop();
}

function linkToken(message: Outgoing | undefined): string {
  if (!message) throw new Error("No reset was sent");
  const match = message.text.match(/token=([\w-]+)/);
  if (!match?.[1]) throw new Error("The reset text carries no token");
  return match[1];
}

beforeAll(() => {
  server = connectDatabase(databaseUrlFromEnvironment());
});

afterAll(async () => {
  await server?.destroy();
});

describe("password reset", () => {
  it("emails a link for an account and stores which account it is for", async () => {
    const installation = await createInstallation();

    await installation.engine.passwordResets.request({ email: "Operator@Example.com" });

    expect(installation.sent).toHaveLength(1);
    expect(installation.sent[0]?.to).toBe("operator@example.com");
    const token = linkToken(installation.sent[0]);
    expect(installation.sent[0]?.text).toContain(
      `${BASE_URL}/api/auth/reset-password?token=${token}`,
    );
    // The identifier has to carry the token so completion can find it; the
    // value names the account, as Better Auth's own reset flow stores it.
    const identity = await installation.engine.accounts.findByEmail("operator@example.com");
    const stored = await installation.database("verification").first("value");
    expect(stored).toEqual({ value: identity?.id });
    await discard(installation);
  });

  it("answers an unknown address exactly like a known one, and sends nothing", async () => {
    const installation = await createInstallation();

    const known = installation.engine.passwordResets.request({ email: "operator@example.com" });
    const unknown = installation.engine.passwordResets.request({ email: "nobody@example.com" });

    await expect(known).resolves.toBeUndefined();
    await expect(unknown).resolves.toBeUndefined();
    expect(installation.sent.map((message) => message.to)).toEqual(["operator@example.com"]);
    await discard(installation);
  });

  it("sets the password the link was issued for, once", async () => {
    const installation = await createInstallation();
    await installation.engine.passwordResets.request({ email: "operator@example.com" });
    const token = linkToken(installation.sent[0]);
    const identity = await installation.engine.accounts.findByEmail("operator@example.com");

    await installation.engine.passwordResets.complete({ token, password: NEW_PASSWORD });
    await expect(
      installation.engine.passwordResets.complete({ token, password: NEW_PASSWORD }),
    ).rejects.toThrow(ResetTokenInvalidError);

    expect(installation.written).toEqual([
      { identityId: identity?.id, password: NEW_PASSWORD },
    ]);
    await discard(installation);
  });

  it("rejects an unknown token without writing a password", async () => {
    const installation = await createInstallation();

    await expect(
      installation.engine.passwordResets.complete({
        token: "never-issued-by-this-installation",
        password: NEW_PASSWORD,
      }),
    ).rejects.toThrow(ResetTokenInvalidError);
    expect(installation.written).toHaveLength(0);
    await discard(installation);
  });

  it("rejects a token once it has expired", async () => {
    const installation = await createInstallation();
    await installation.engine.passwordResets.request({ email: "operator@example.com" });
    const token = linkToken(installation.sent[0]);

    installation.advance(2 * 60 * 60 * 1_000);
    await expect(
      installation.engine.passwordResets.complete({ token, password: NEW_PASSWORD }),
    ).rejects.toThrow(ResetTokenInvalidError);
    expect(installation.written).toHaveLength(0);
    await discard(installation);
  });

  it("lets only one of two simultaneous completions write a password", async () => {
    const installation = await createInstallation();
    await installation.engine.passwordResets.request({ email: "operator@example.com" });
    const token = linkToken(installation.sent[0]);
    const complete = (password: string) =>
      installation.engine.passwordResets
        .complete({ token, password })
        .then(
          () => "reset",
          () => "refused",
        );

    const outcomes = await Promise.all([complete(NEW_PASSWORD), complete(PASSWORD)]);

    expect(outcomes.sort()).toEqual(["refused", "reset"]);
    expect(installation.written).toHaveLength(1);
    await discard(installation);
  });

  it("refuses explicitly when the installation has no way to send email", async () => {
    const installation = await createInstallation({ withMailer: false });

    await expect(
      installation.engine.passwordResets.request({ email: "operator@example.com" }),
    ).rejects.toThrow(EmailUnavailableError);
    expect(await installation.database("verification")).toHaveLength(0);
    await discard(installation);
  });

  it("leaves no token behind when delivery fails", async () => {
    const installation = await createInstallation();
    installation.deliverWith(async () => {
      throw new Error("relay refused the message");
    });

    await expect(
      installation.engine.passwordResets.request({ email: "operator@example.com" }),
    ).rejects.toThrow("relay refused the message");
    expect(await installation.database("verification")).toHaveLength(0);
    await discard(installation);
  });
});
