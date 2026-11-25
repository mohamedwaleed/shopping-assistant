import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  connectDatabase,
  databaseUrlFromEnvironment,
  withSearchPath,
  type Database,
} from "@shopping-assistant/database";
import { createAccount, createTestSchema, migrate } from "@shopping-assistant/database/testing";
import {
  AccountAlreadyExistsError,
  createEngine,
  EmailUnavailableError,
  InvitationInvalidError,
  InvitationRefusedError,
  type Engine,
} from "./index.ts";
import { createFakeIdentityStore } from "./testing/fake-identity-store.ts";

const SETUP_TOKEN = "setup-token-0f9c1c1e4b6d4a51a2c3f0e5d7b8a9c6";
const BASE_URL = "https://shopping.example";
const PASSWORD = "correct-horse-battery-staple";

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
  /** Moves the engine's clock without waiting for a real week. */
  advance: (milliseconds: number) => void;
  /** Replaces delivery, so a failing relay can be simulated. */
  deliverWith: (send: (message: Outgoing) => Promise<void>) => void;
  drop: () => Promise<void>;
}

/** The closed installation an invitation is meant to open a door into. */
async function createInstallation({
  registrationOpen = false,
  withMailer = true,
}: { registrationOpen?: boolean; withMailer?: boolean } = {}): Promise<Installation> {
  const { schema, drop } = await createTestSchema(server);
  const database = connectDatabase(withSearchPath(databaseUrlFromEnvironment(), schema));
  await migrate(database);
  const sent: Outgoing[] = [];
  const clock = { now: new Date("2026-03-01T09:00:00.000Z") };
  let deliver = async (message: Outgoing) => {
    sent.push(message);
  };
  const mailer = {
    send: (message: Outgoing) => deliver(message),
  };
  const engine = createEngine({
    database,
    setupToken: SETUP_TOKEN,
    identity: createFakeIdentityStore(),
    accounts: {
      ...(withMailer ? { email: { baseUrl: BASE_URL, mailer } } : {}),
    },
    now: () => clock.now,
  });
  await engine.setup.complete({
    setupToken: SETUP_TOKEN,
    email: "operator@example.com",
    password: PASSWORD,
  });
  await database("installation").update({ registration_open: registrationOpen });
  return {
    database,
    engine,
    sent,
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

async function adminId(database: Database): Promise<string> {
  const row = await database("profiles")
    .where({ email: "operator@example.com" })
    .first<{ id: string }>("id");
  if (!row) throw new Error("The bootstrap admin is missing");
  return row.id;
}

function linkToken(message: Outgoing | undefined): string {
  if (!message) throw new Error("No invitation was sent");
  const match = message.text.match(/token=([\w-]+)/);
  if (!match?.[1]) throw new Error("The invitation text carries no token");
  return match[1];
}

beforeAll(() => {
  server = connectDatabase(databaseUrlFromEnvironment());
});

afterAll(async () => {
  await server?.destroy();
});

describe("admin invitations", () => {
  it("emails a link to an address an admin named, and stores only its digest", async () => {
    const installation = await createInstallation();

    const invitation = await installation.engine.invitations.invite(
      await adminId(installation.database),
      { email: "Invitee@Example.com" },
    );

    expect(installation.sent).toHaveLength(1);
    expect(installation.sent[0]).toMatchObject({ to: "invitee@example.com" });
    expect(installation.sent[0]?.text).toContain(
      `${BASE_URL}/api/auth/accept-invitation?token=${invitation.token}`,
    );
    expect(invitation.email).toBe("invitee@example.com");
    // The link is the credential, so the table must not hold it.
    const stored = await installation.database("invitations").first("token_hash");
    expect(JSON.stringify(stored)).not.toContain(invitation.token);
    await discard(installation);
  });

  it("refuses an invitation from an ordinary account", async () => {
    const installation = await createInstallation();
    const shopperId = await createAccount(installation.database, "shopper@example.com");

    await expect(
      installation.engine.invitations.invite(shopperId, { email: "friend@example.com" }),
    ).rejects.toThrow(InvitationRefusedError);
    expect(installation.sent).toHaveLength(0);
    await discard(installation);
  });

  it("refuses an invitation from an identity that has no account", async () => {
    const installation = await createInstallation();

    await expect(
      installation.engine.invitations.invite(
        "1e0d1b2c-5f43-4a6b-9c8d-7e6f5a4b3c2d",
        { email: "friend@example.com" },
      ),
    ).rejects.toThrow(InvitationRefusedError);
    await discard(installation);
  });

  it("creates an ordinary account from a valid invitation while registration is closed", async () => {
    const installation = await createInstallation({ registrationOpen: false });
    const invitation = await installation.engine.invitations.invite(
      await adminId(installation.database),
      { email: "invitee@example.com" },
    );

    const accepted = await installation.engine.invitations.accept({
      token: invitation.token,
      name: "Invitee",
      password: PASSWORD,
    });

    expect(accepted.email).toBe("invitee@example.com");
    expect(accepted.account).toMatchObject({ email: "invitee@example.com", role: "user" });
    expect(await installation.engine.accounts.isRegistrationOpen()).toBe(false);
    const acceptedAt = await installation.database("invitations")
      .where({ id: invitation.id })
      .first<{ accepted_at: Date | null; accepted_by: string | null }>(
        "accepted_at",
        "accepted_by",
      );
    expect(acceptedAt?.accepted_at).toBeInstanceOf(Date);
    expect(acceptedAt?.accepted_by).toBe(accepted.account.id);
    await discard(installation);
  });

  it("rejects an unknown token", async () => {
    const installation = await createInstallation();

    await expect(
      installation.engine.invitations.accept({
        token: "not-a-token-that-was-ever-issued",
        name: "Stranger",
        password: PASSWORD,
      }),
    ).rejects.toThrow(InvitationInvalidError);
    expect(await installation.database("profiles").where({ email: "stranger@example.com" })).toEqual(
      [],
    );
    await discard(installation);
  });

  it("rejects a token whose link was altered", async () => {
    const installation = await createInstallation();
    const invitation = await installation.engine.invitations.invite(
      await adminId(installation.database),
      { email: "invitee@example.com" },
    );

    await expect(
      installation.engine.invitations.accept({
        token: `${invitation.token.slice(0, -1)}${invitation.token.endsWith("A") ? "B" : "A"}`,
        name: "Tampered",
        password: PASSWORD,
      }),
    ).rejects.toThrow(InvitationInvalidError);
    await discard(installation);
  });

  it("rejects a token once it has expired", async () => {
    const installation = await createInstallation();
    const invitation = await installation.engine.invitations.invite(
      await adminId(installation.database),
      { email: "invitee@example.com" },
    );

    installation.advance(8 * 24 * 60 * 60 * 1_000);
    await expect(
      installation.engine.invitations.accept({
        token: invitation.token,
        name: "Late",
        password: PASSWORD,
      }),
    ).rejects.toThrow(InvitationInvalidError);
    expect(await installation.engine.accounts.findByEmail("invitee@example.com")).toBeUndefined();
    await discard(installation);
  });

  it("rejects a replayed token and leaves exactly one account behind", async () => {
    const installation = await createInstallation();
    const invitation = await installation.engine.invitations.invite(
      await adminId(installation.database),
      { email: "invitee@example.com" },
    );
    const accept = (name: string) =>
      installation.engine.invitations.accept({
        token: invitation.token,
        name,
        password: PASSWORD,
      });

    await accept("First");
    await expect(accept("Second")).rejects.toThrow(InvitationInvalidError);

    expect(await installation.database("profiles").where({ role: "user" })).toHaveLength(1);
    expect(await installation.database("user").where({ email: "invitee@example.com" })).toHaveLength(
      1,
    );
    await discard(installation);
  });

  it("lets only one of two simultaneous redemptions create the account", async () => {
    const installation = await createInstallation();
    const invitation = await installation.engine.invitations.invite(
      await adminId(installation.database),
      { email: "invitee@example.com" },
    );
    const accept = (name: string) =>
      installation.engine.invitations
        .accept({ token: invitation.token, name, password: PASSWORD })
        .then(
          () => "accepted",
          () => "refused",
        );

    const outcomes = await Promise.all([accept("One"), accept("Two")]);

    expect(outcomes.sort()).toEqual(["accepted", "refused"]);
    expect(await installation.database("profiles").where({ role: "user" })).toHaveLength(1);
    expect(await installation.database("user").where({ email: "invitee@example.com" })).toHaveLength(
      1,
    );
    await discard(installation);
  });

  it("refuses a second live invitation for the same address", async () => {
    const installation = await createInstallation();
    const admin = await adminId(installation.database);
    await installation.engine.invitations.invite(admin, { email: "invitee@example.com" });

    await expect(
      installation.engine.invitations.invite(admin, { email: "INVITEE@example.com" }),
    ).rejects.toThrow(AccountAlreadyExistsError);
    expect(installation.sent).toHaveLength(1);
    await discard(installation);
  });

  it("leaves no invitation behind when delivery fails, so the address can be invited again", async () => {
    const installation = await createInstallation();
    const admin = await adminId(installation.database);
    installation.deliverWith(async () => {
      throw new Error("relay refused the message");
    });

    await expect(
      installation.engine.invitations.invite(admin, { email: "invitee@example.com" }),
    ).rejects.toThrow("relay refused the message");
    expect(await installation.database("invitations")).toHaveLength(0);

    installation.deliverWith(async (message) => {
      installation.sent.push(message);
    });
    await installation.engine.invitations.invite(admin, { email: "invitee@example.com" });
    expect(installation.sent).toHaveLength(1);
    await discard(installation);
  });

  it("refuses explicitly when the installation has no way to send email", async () => {
    const installation = await createInstallation({ withMailer: false });

    await expect(
      installation.engine.invitations.invite(await adminId(installation.database), {
        email: "invitee@example.com",
      }),
    ).rejects.toThrow(EmailUnavailableError);
    await discard(installation);
  });
});
