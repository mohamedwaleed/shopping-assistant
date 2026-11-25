import type { RequestListener } from "node:http";
import type { Engine } from "@shopping-assistant/engine";
import type { Auth } from "./auth.ts";
import { relay } from "./identity.ts";

/** Where every Better Auth route is mounted; its own base path sits inside it. */
const AUTH_PATH_PREFIX = "/api/auth";
const SIGN_UP_PATH = `${AUTH_PATH_PREFIX}/sign-up/email`;
const MAXIMUM_BODY_BYTES = 4_096;

/**
 * Everything Better Auth serves — sign-up, verification, sign-in, sign-out,
 * session — under one prefix. Route-specific behaviour lives in Better Auth's
 * own endpoints rather than being reimplemented here.
 *
 * Sign-up is the one exception: the identity is Better Auth's, but the profile
 * the engine authorises against is ours, so the response is read before it is
 * relayed.
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
        await relay(auth, request, response);
        return;
      }
      const payload = JSON.stringify({ error: "Not found" });
      response.writeHead(404, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(payload),
      });
      response.end(payload);
    })().catch(() => {
      if (!response.headersSent) {
        const payload = JSON.stringify({ error: "Authentication failed" });
        response.writeHead(500, {
          "content-type": "application/json; charset=utf-8",
          "content-length": Buffer.byteLength(payload),
        });
        response.end(payload);
      }
    });
  };

  /**
   * Runs Better Auth's own sign-up endpoint as a `Response`, so its status,
   * cookies, and error bodies are exactly what its handler would produce, then
   * records the profile for a newly created identity.
   */
  async function signUp(request: Parameters<RequestListener>[0], response: Parameters<RequestListener>[1]) {
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
}

function fromIncoming(headers: Parameters<RequestListener>[0]["headers"]): Headers {
  const converted = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    converted.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return converted;
}

async function readJson(request: Parameters<RequestListener>[0]): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAXIMUM_BODY_BYTES) throw new RangeError("Request body too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}
