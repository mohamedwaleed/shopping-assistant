import type { IncomingMessage, ServerResponse } from "node:http";
import { fromNodeHeaders } from "better-auth/node";
import { hashPassword } from "better-auth/crypto";
import type { AuthIdentityStore } from "@shopping-assistant/engine";
import type { Auth } from "./auth.ts";

export interface AuthenticatedUser {
  id: string;
  email: string;
  emailVerified: boolean;
}

/**
 * Creates identities for the engine. Better Auth's transaction is tracked in
 * its own async storage, so passing the engine's knex transaction here would
 * not reach the inserts Better Auth makes. A failure therefore removes the
 * identity it just created instead of leaving it behind.
 */
export function createIdentityStore(auth: Auth): AuthIdentityStore {
  return {
    async createUser(identity, _connection) {
      const context = await auth.$context;
      const user = await context.internalAdapter.createUser(
        {
          email: identity.email,
          name: identity.name,
          emailVerified: false,
        },
        { method: "email-password" },
      );
      try {
        const password = await hashPassword(identity.password);
        await createCredentialAccount(context, user.id, password);
      } catch (error) {
        await context.internalAdapter.deleteUser(user.id);
        throw error;
      }
      return { id: user.id };
    },

    async findUserByEmail(email) {
      const context = await auth.$context;
      const found = await context.internalAdapter.findUserByEmail(email);
      return found ? { id: found.user.id, email: found.user.email } : undefined;
    },
  };
}

async function createCredentialAccount(
  context: Awaited<Auth["$context"]>,
  userId: string,
  password: string,
): Promise<void> {
  const account = await context.internalAdapter.createAccount({
    accountId: userId,
    providerId: "credential",
    userId,
    password,
  });
  if (!account) throw new Error("Credential account was not created");
}

/** The signed-in shopper, or `undefined` when the request carries no live session. */
export async function currentUser(
  auth: Auth,
  request: IncomingMessage,
): Promise<AuthenticatedUser | undefined> {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
  if (!session) return undefined;
  return {
    id: session.user.id,
    email: session.user.email,
    emailVerified: session.user.emailVerified,
  };
}

/** Better Auth answers with a `Response`; Node needs it written to the raw socket. */
export async function relay(
  auth: Auth,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const body = hasBody ? await readBody(request) : undefined;

  // Re-based onto the configured base URL so Better Auth's own path matching
  // and origin checks see the deployment's origin, not the socket's.
  const target = new URL(url.pathname + url.search, auth.options.baseURL);
  const answer = await auth.handler(
    new Request(target, {
      method: request.method ?? "GET",
      headers,
      ...(body ? { body } : {}),
    }),
  );

  response.writeHead(answer.status, Object.fromEntries(answer.headers.entries()));
  response.end(Buffer.from(await answer.arrayBuffer()));
}

const MAXIMUM_BODY_BYTES = 4_096;

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAXIMUM_BODY_BYTES) throw new RangeError("Request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}
