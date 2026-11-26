import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import {
  AccountNotFoundError,
  LastAdminProtectedError,
  NotAnAdminError,
  PolicyRefusedError,
  type Account,
  type Actor,
  type Engine,
  type InstallationPolicy,
  type PolicyChange,
} from "./index.ts";

const MAXIMUM_BODY_BYTES = 4_096;

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  response.end(payload);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAXIMUM_BODY_BYTES) throw new RangeError("Request body too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** The public shape of an account: no credentials, no sessions, no data. */
function accountView(account: Account): unknown {
  return {
    id: account.id,
    email: account.email,
    role: account.role,
    disabled: account.disabled,
    createdAt: account.createdAt.toISOString(),
  };
}

function policyView(policy: InstallationPolicy, engine: Engine): unknown {
  return {
    registrationOpen: policy.registrationOpen,
    modelId: policy.modelId ?? null,
    revision: policy.revision,
    updatedAt: policy.updatedAt?.toISOString() ?? null,
    modelOptions: engine.administration.modelOptions(),
  };
}

/**
 * The models an admin may choose between, with how each is reached and whether
 * the deployment has a provider for it. `activeModelId` is what a conversation
 * would use now: the admin's choice where there is one, and the deployment's
 * own choice otherwise, so the screen never has to guess.
 */
function modelsView(
  policy: InstallationPolicy,
  catalog: Awaited<ReturnType<Engine["administration"]["modelCatalog"]>>,
  engine: Engine,
): unknown {
  const offered = engine.administration.modelOptions().map((option) => option.id);
  const active = policy.modelId ?? offered[0] ?? null;
  return {
    activeModelId: active,
    chosenByAdmin: policy.modelId !== undefined,
    models: catalog.map((entry) => ({
      id: entry.id,
      label: entry.label,
      description: entry.description,
      provider: entry.provider ?? null,
      readiness: entry.provider ? "configured" : "unconfigured",
    })),
  };
}

/**
 * The thin administration contract for the dashboard. Who the caller is comes
 * from the verified session, which the web layer resolves and passes in as the
 * actor; this listener never trusts a body or a header to name the actor.
 */
export function createAdministrationServer({
  engine,
  actorOf,
}: {
  engine: Engine;
  /** Resolves the caller from the request's verified session. */
  actorOf: (request: IncomingMessage) => Promise<Actor | undefined>;
}): RequestListener {
  return (request, response) => {
    const { pathname } = new URL(request.url ?? "/", "http://localhost");
    const { method } = request;

    void (async () => {
      if (!pathname.startsWith("/administration")) {
        send(response, 404, { error: "Not found" });
        return;
      }

      const actor = await actorOf(request);
      if (!actor) {
        // No verified session: the caller is not identified at all.
        send(response, 401, { error: "Authentication required" });
        return;
      }

      try {
        if (pathname === "/administration/accounts" && method === "GET") {
          send(response, 200, (await engine.accounts.list(actor)).map(accountView));
          return;
        }

        const change = /^\/administration\/accounts\/([^/]+)\/(promote|demote|disable|enable)$/.exec(
          pathname,
        );
        if (change && method === "POST") {
          const [, identityId, operation] = change;
          if (!identityId) throw new AccountNotFoundError();
          const account =
            operation === "promote"
              ? await engine.accounts.promote(actor, identityId)
              : operation === "demote"
                ? await engine.accounts.demote(actor, identityId)
                : operation === "disable"
                  ? await engine.accounts.disable(actor, identityId)
                  : await engine.accounts.enable(actor, identityId);
          send(response, 200, accountView(account));
          return;
        }

        if (pathname === "/administration/policy" && method === "GET") {
          send(response, 200, policyView(await engine.accounts.policy(), engine));
          return;
        }

        if (pathname === "/administration/models" && method === "GET") {
          send(
            response,
            200,
            modelsView(
              await engine.accounts.policy(),
              await engine.administration.modelCatalog(actor),
              engine,
            ),
          );
          return;
        }

        if (pathname === "/administration/policy" && method === "PATCH") {
          const body = await readJson(request).catch((error: unknown) => error);
          if (body instanceof RangeError) {
            send(response, 413, { error: "Request body too large" });
            return;
          }
          const parsed = policyChange(body);
          if (!parsed) {
            send(response, 400, { error: "Expected registrationOpen and/or modelId" });
            return;
          }
          send(response, 200, policyView(await engine.accounts.updatePolicy(actor, parsed), engine));
          return;
        }

        send(response, 404, { error: "Not found" });
      } catch (error) {
        refuse(response, error);
      }
    })().catch(() => {
      if (!response.headersSent) send(response, 500, { error: "Administration failed" });
    });
  };
}

/** Only the fields an admin may set, and only with the types the engine takes. */
function policyChange(body: unknown): PolicyChange | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const { registrationOpen, modelId } = body as Record<string, unknown>;
  const change: PolicyChange = {};
  if (registrationOpen !== undefined) {
    if (typeof registrationOpen !== "boolean") return undefined;
    change.registrationOpen = registrationOpen;
  }
  if (modelId !== undefined) {
    if (modelId !== null && typeof modelId !== "string") return undefined;
    change.modelId = modelId;
  }
  return change;
}

/**
 * Each refusal has one status, so a caller can act on it without parsing a
 * message, and the body never repeats anything the caller submitted.
 */
function refuse(response: ServerResponse, error: unknown): void {
  if (error instanceof NotAnAdminError) {
    send(response, 403, { error: "Administrator permission is required" });
  } else if (error instanceof LastAdminProtectedError) {
    send(response, 409, { error: "The installation must keep an active admin" });
  } else if (error instanceof AccountNotFoundError) {
    send(response, 404, { error: "Account not found" });
  } else if (error instanceof PolicyRefusedError) {
    send(response, 422, { error: "That change is outside what the deployment allows" });
  } else {
    throw error;
  }
}
