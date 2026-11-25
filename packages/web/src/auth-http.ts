import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import {
  AccountAlreadyExistsError,
  EmailUnavailableError,
  InvitationInvalidError,
  InvitationRefusedError,
  ResetTokenInvalidError,
  type Engine,
} from "@shopping-assistant/engine";
import { markEmailVerified } from "./account-links.ts";
import type { Auth } from "./auth.ts";
import { currentUser, relay } from "./identity.ts";

/** Where every Better Auth route is mounted; its own base path sits inside it. */
const AUTH_PATH_PREFIX = "/api/auth";
const SIGN_UP_PATH = `${AUTH_PATH_PREFIX}/sign-up/email`;
const INVITATIONS_PATH = `${AUTH_PATH_PREFIX}/invitations`;
const ACCEPT_INVITATION_PATH = `${AUTH_PATH_PREFIX}/accept-invitation`;
const REQUEST_PASSWORD_RESET_PATH = `${AUTH_PATH_PREFIX}/request-password-reset`;
const RESET_PASSWORD_PATH = `${AUTH_PATH_PREFIX}/reset-password`;
const MAXIMUM_BODY_BYTES = 4_096;

/**
 * Everything Better Auth serves — sign-up, verification, sign-in, sign-out,
 * session — under one prefix. Route-specific behaviour lives in Better Auth's
 * own endpoints rather than being reimplemented here.
 *
 * Sign-up is the one exception: the identity is Better Auth's, but the profile
 * the engine authorises against is ours, so the response is read before it is
 * relayed. Invitations and password resets are the others, for the same reason:
 * the engine decides whether they are allowed, and the web layer only writes
 * what it decided.
 */
export function createAuthServer({ auth, engine }: { auth: Auth; engine: Engine }): RequestListener {
  return (request, response) => {
    const { pathname } = new URL(request.url ?? "/", "http://localhost");

    void (async () => {
      if (pathname === AUTH_PATH_PREFIX || pathname.startsWith(`${AUTH_PATH_PREFIX}/`)) {
        if (pathname === SIGN_UP_PATH && request.method === "POST") {
          await signUp(request, response);
          return;
        }
        if (pathname === INVITATIONS_PATH && request.method === "POST") {
          await invite(request, response);
          return;
        }
        if (pathname === ACCEPT_INVITATION_PATH) {
          if (request.method === "GET") await describeInvitation(request, response);
          else if (request.method === "POST") await acceptInvitation(request, response);
          else send(response, 405, { error: "Method not allowed" });
          return;
        }
        if (pathname === REQUEST_PASSWORD_RESET_PATH && request.method === "POST") {
          await requestPasswordReset(request, response);
          return;
        }
        if (pathname === RESET_PASSWORD_PATH) {
          if (request.method === "GET") describePasswordReset(request, response);
          else if (request.method === "POST") await resetPassword(request, response);
          else send(response, 405, { error: "Method not allowed" });
          return;
        }
        await relay(auth, request, response);
        return;
      }
      send(response, 404, { error: "Not found" });
    })().catch(() => {
      send(response, 500, { error: "Authentication failed" });
    });
  };

  /**
   * Runs Better Auth's own sign-up endpoint as a `Response`, so its status,
   * cookies, and error bodies are exactly what its handler would produce, then
   * records the profile for a newly created identity.
   */
  async function signUp(request: IncomingMessage, response: ServerResponse) {
    const body = await readJson(request);
    const answer = (await auth.api.signUpEmail({
      body: body as { name: string; email: string; password: string },
      asResponse: true,
      headers: fromIncoming(request.headers),
    })) as unknown as Response;

    if (answer.ok) {
      const payload = (await answer.clone().json()) as { user?: { id: string; email: string } };
      const user = payload.user;
      // A refused identity never reaches here: closed registration is rejected
      // by the user-creation hook before any row exists.
      if (user) await engine.accounts.register({ identityId: user.id, email: user.email });
    }

    response.writeHead(answer.status, Object.fromEntries(answer.headers.entries()));
    response.end(Buffer.from(await answer.arrayBuffer()));
  }

  /** Issues an invitation on behalf of the signed-in admin. */
  async function invite(request: IncomingMessage, response: ServerResponse) {
    const admin = await currentUser(auth, request, engine.accounts);
    if (!admin) {
      send(response, 401, { error: "Sign in as an admin to invite someone" });
      return;
    }
    const body = await readJson(request);
    const email = body.email;
    if (typeof email !== "string" || !email.includes("@")) {
      send(response, 400, { error: "Expected an email address" });
      return;
    }
    try {
      const invitation = await engine.invitations.invite(admin.id, { email });
      // The token itself is not returned: it reached the recipient's inbox, and
      // an admin reading it could join as them.
      send(response, 201, {
        email: invitation.email,
        expiresAt: invitation.expiresAt,
      });
    } catch (error) {
      sendRefusal(response, error);
    }
  }

  /** Tells the screen who an emailed link is for, before it asks for a password. */
  async function describeInvitation(request: IncomingMessage, response: ServerResponse) {
    const token = tokenFrom(request);
    if (!token) {
      send(response, 400, { error: "The invitation link is invalid, expired, or already used" });
      return;
    }
    const invitation = await engine.invitations.find(token);
    if (!invitation) {
      send(response, 410, { error: "The invitation link is invalid, expired, or already used" });
      return;
    }
    send(response, 200, { email: invitation.email, expiresAt: invitation.expiresAt });
  }

  /** Creates the invited account, choosing the name and password it signs in with. */
  async function acceptInvitation(request: IncomingMessage, response: ServerResponse) {
    const body = await readJson(request);
    const { token, name, password } = body;
    if (typeof token !== "string" || typeof name !== "string" || typeof password !== "string") {
      send(response, 400, { error: "Expected token, name and password" });
      return;
    }
    try {
      const accepted = await engine.invitations.accept({ token, name, password });
      await markEmailVerified(auth, accepted.account.id);
      // Sign-in is the next step the screen takes; the response says which
      // address and role it will be, never the credential.
      send(response, 201, { email: accepted.email, role: accepted.account.role });
    } catch (error) {
      sendRefusal(response, error);
    }
  }

  /**
   * Asks for a reset link. The answer is identical for an address with an
   * account and one without, so it cannot be used to discover who has one.
   */
  async function requestPasswordReset(request: IncomingMessage, response: ServerResponse) {
    const body = await readJson(request);
    const email = body.email;
    if (typeof email !== "string" || !email.includes("@")) {
      send(response, 400, { error: "Expected an email address" });
      return;
    }
    try {
      await engine.passwordResets.request({ email });
      send(response, 202, {
        message: "If this address has an account, a reset link is on its way",
      });
    } catch (error) {
      sendRefusal(response, error);
    }
  }

  /** Tells the screen which account a reset link belongs to, so it can ask for a new password. */
  function describePasswordReset(request: IncomingMessage, response: ServerResponse) {
    const token = tokenFrom(request);
    if (!token) {
      send(response, 400, { error: "The reset link is invalid, expired, or already used" });
      return;
    }
    // Nothing about the account is disclosed before the password is chosen: the
    // link proves the inbox, not the identity, and completion is the only step
    // that needs the account.
    send(response, 200, { token: "present" });
  }

  /** Sets the new password the reset link was issued for. */
  async function resetPassword(request: IncomingMessage, response: ServerResponse) {
    const body = await readJson(request);
    const { token, password } = body;
    if (typeof token !== "string" || typeof password !== "string") {
      send(response, 400, { error: "Expected token and password" });
      return;
    }
    try {
      await engine.passwordResets.complete({ token, password });
      send(response, 200, { status: "password-reset" });
    } catch (error) {
      sendRefusal(response, error);
    }
  }
}

/**
 * One place for what each refusal means over HTTP. None of them repeats a token
 * or an address, and the invalid-link answers are deliberately identical for
 * unknown, spent, and expired links.
 */
function sendRefusal(response: ServerResponse, error: unknown): void {
  if (error instanceof InvitationInvalidError || error instanceof ResetTokenInvalidError) {
    send(response, 410, { error: error.message });
    return;
  }
  if (error instanceof InvitationRefusedError) {
    send(response, 403, { error: error.message });
    return;
  }
  if (error instanceof AccountAlreadyExistsError) {
    send(response, 409, { error: "That address already has an account or a live invitation" });
    return;
  }
  if (error instanceof EmailUnavailableError) {
    send(response, 503, { error: error.message });
    return;
  }
  throw error;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return;
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  response.end(payload);
}

function tokenFrom(request: IncomingMessage): string | undefined {
  const url = new URL(request.url ?? "/", "http://localhost");
  const token = url.searchParams.get("token");
  return token ? token : undefined;
}

function fromIncoming(headers: IncomingMessage["headers"]): Headers {
  const converted = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    converted.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return converted;
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAXIMUM_BODY_BYTES) throw new RangeError("Request body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}
