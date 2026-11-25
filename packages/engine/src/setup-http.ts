import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import {
  SetupClosedError,
  SetupTokenRejectedError,
  type Engine,
  type InstallationReadiness,
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

function bootstrapInput(
  body: unknown,
): { setupToken: string; email: string; password: string } | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const { setupToken, email, password } = body as Record<string, unknown>;
  if (typeof setupToken !== "string" || typeof email !== "string") return undefined;
  if (typeof password !== "string") return undefined;
  return { setupToken, email, password };
}

/**
 * The thin setup contract for the installation screen. The setup token travels
 * in the request body only: never in a URL, a response, or a log line.
 */
export function createSetupServer({ engine }: { engine: Engine }): RequestListener {
  return (request, response) => {
    const { pathname } = new URL(request.url ?? "/", "http://localhost");

    void (async () => {
      if (pathname === "/setup" && request.method === "GET") {
        const readiness: InstallationReadiness = await engine.setup.readiness();
        send(response, 200, readiness);
        return;
      }

      if (pathname === "/setup/complete" && request.method === "POST") {
        const body = await readJson(request).catch((error: unknown) => error);
        if (body instanceof RangeError) {
          send(response, 413, { error: "Request body too large" });
          return;
        }
        const input = bootstrapInput(body);
        if (!input) {
          send(response, 400, { error: "Expected setupToken, email and password" });
          return;
        }
        try {
          send(response, 201, await engine.setup.complete(input));
        } catch (error) {
          if (error instanceof SetupTokenRejectedError) {
            send(response, 403, { error: "Setup token rejected" });
          } else if (error instanceof SetupClosedError) {
            send(response, 409, { error: "Setup is already complete" });
          } else {
            throw error;
          }
        }
        return;
      }

      send(response, 404, { error: "Not found" });
    })().catch(() => {
      send(response, 500, { error: "Setup failed" });
    });
  };
}
