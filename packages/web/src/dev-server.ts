/**
 * Runs the installation on one port for manual testing:
 *
 *   node --experimental-strip-types --no-warnings packages/web/src/dev-server.ts
 *
 * Settings come from the environment exactly as the application reads them
 * (`loadSettings`). Email is recorded rather than sent, so a verification,
 * invitation, or reset link is printed here instead of reaching an inbox.
 * The release ticket replaces this with the real web application.
 */
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { loadSettings } from "@shopping-assistant/config";
import { connectDatabase } from "@shopping-assistant/database";
import { createEngine } from "@shopping-assistant/engine";
import { createAdministrationServer } from "@shopping-assistant/engine/administration-http";
import { createSetupServer } from "@shopping-assistant/engine/setup-http";
import { createAuth } from "./auth.ts";
import { createAuthServer } from "./auth-http.ts";
import { createPasswordSetter } from "./account-links.ts";
import { createIdentityStore, currentUser } from "./identity.ts";
import { createRecordingMailer, type OutgoingEmail } from "./mailer.ts";

const settings = loadSettings();
const database = connectDatabase(settings.databaseUrl);
const mailer = createRecordingMailer();

// Links are built from the address the server actually listens on, which is
// only known once it is bound, so the origin is read back per request.
let origin = settings.publicBaseUrl;

const auth = createAuth({
  database,
  secret: settings.authSecret,
  baseUrl: origin,
  mailer,
  installation: async () => ({
    bootstrapped: (await engine.setup.readiness()).setup === "closed",
    registrationOpen: await engine.accounts.isRegistrationOpen(),
  }),
});

const engine = createEngine({
  database,
  setupToken: settings.setupToken,
  identity: createIdentityStore(auth),
  accounts: { email: { baseUrl: origin, mailer }, passwords: createPasswordSetter(auth) },
  ...(settings.retrievalCostCents === undefined
    ? {}
    : { retrievalCostCents: settings.retrievalCostCents }),
  ...(settings.discovery ? { services: { discovery: settings.discovery } } : {}),
});

/** The caller of an administration request, resolved from its verified session. */
async function actorOf(request: IncomingMessage) {
  const user = await currentUser(auth, request, engine.accounts);
  return user ? { id: user.id } : undefined;
}

const authServer = createAuthServer({ auth, engine });
const administrationServer = createAdministrationServer({ engine, actorOf });
const setupServer = createSetupServer({ engine });

const server = createServer((request, response) => {
  const { pathname } = new URL(request.url ?? "/", "http://localhost");
  if (pathname.startsWith("/administration")) return administrationServer(request, response);
  if (pathname.startsWith("/setup")) return setupServer(request, response);
  return authServer(request, response);
});

server.listen(Number(new URL(origin).port), "127.0.0.1", () => {
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.stdout.write(`listening on ${origin}\n`);
});

/** Print every recorded email, because nothing is actually delivered here. */
const send = mailer.send.bind(mailer);
mailer.send = async (message: OutgoingEmail) => {
  await send(message);
  process.stdout.write(`\n--- email to ${message.to} ---\n${message.subject}\n${message.text}\n`);
};
