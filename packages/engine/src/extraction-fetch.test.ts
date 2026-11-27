import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fetchPage, DEFAULT_FETCH_BOUNDS, type FetchBounds } from "./extraction/fetch.ts";

/**
 * The retrieval bounds, exercised against controlled HTTP endpoints. Nothing
 * here reaches the internet: every server is one this file starts, and every
 * name is one this file resolves.
 *
 * The fixtures point a public-looking name at a loopback server, which is
 * exactly the SSRF shape the destination rules exist to refuse. `permitted` is
 * the one exception that makes the test possible: it names the address the
 * fixture is allowed to reach, and nothing else. A deployment leaves it empty.
 */

const LOOPBACK = "127.0.0.1";
const PUBLIC_NAME = "shop.example.test";

interface Fixture {
  server: Server;
  port: number;
  url: (path: string) => string;
  close: () => Promise<void>;
}

const fixtures: Fixture[] = [];

async function serve(
  handler: Parameters<typeof createServer>[1],
): Promise<Fixture> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, LOOPBACK, resolve));
  const { port } = server.address() as AddressInfo;
  const fixture: Fixture = {
    server,
    port,
    url: (path) => `http://${PUBLIC_NAME}:${port}${path}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  fixtures.push(fixture);
  return fixture;
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

/** The bounds a fixture needs, with its own port and address permitted. */
function boundsFor(fixture: Fixture, overrides: Partial<FetchBounds> = {}): FetchBounds {
  return {
    ...DEFAULT_FETCH_BOUNDS,
    permittedPorts: [fixture.port],
    ...overrides,
  };
}

/** The resolver a fixture needs: the public name answers with loopback. */
const resolveToLoopback = async () => [LOOPBACK];

function fetchFixture(fixture: Fixture, path: string, overrides: Partial<FetchBounds> = {}) {
  return fetchPage(fixture.url(path), {
    bounds: boundsFor(fixture, overrides),
    resolve: resolveToLoopback,
    permittedAddresses: [LOOPBACK],
  });
}

/** The headers a product page is served with. */
const HTML = { "content-type": "text/html; charset=utf-8" };

describe("bounded retrieval", () => {
  it("reads an HTML page and reports where it came from", async () => {
    const fixture = await serve((_request, response) => {
      response.writeHead(200, HTML);
      response.end("<html><body><p>Helmet</p></body></html>");
    });

    const outcome = await fetchFixture(fixture, "/p/helmet");

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.page.status).toBe(200);
    expect(outcome.page.mediaType).toBe("text/html");
    expect(outcome.page.url).toBe(fixture.url("/p/helmet"));
    expect(outcome.page.chain).toEqual([fixture.url("/p/helmet")]);
    expect(new TextDecoder().decode(outcome.page.bytes)).toContain("Helmet");
  });

  it("refuses a private destination without opening a connection", async () => {
    let reached = false;
    const fixture = await serve((_request, response) => {
      reached = true;
      response.writeHead(200, HTML);
      response.end("<html></html>");
    });

    // A public-looking name that resolves into the metadata range, and a
    // literal private address: neither may be requested.
    const byName = await fetchPage(`http://metadata.example.test:${fixture.port}/`, {
      bounds: boundsFor(fixture),
      resolve: async () => ["169.254.169.254"],
    });
    const literal = await fetchPage(`http://10.0.0.5:${fixture.port}/`, {
      bounds: boundsFor(fixture),
      resolve: async () => [LOOPBACK],
    });
    const localhost = await fetchPage(`http://localhost:${fixture.port}/`, {
      bounds: boundsFor(fixture),
      resolve: async () => [LOOPBACK],
    });

    expect(byName).toMatchObject({
      ok: false,
      failure: { kind: "refused", refusal: { target: "169.254.169.254", reason: "address" } },
    });
    expect(literal).toMatchObject({
      ok: false,
      failure: { kind: "refused", refusal: { reason: "address" } },
    });
    expect(localhost).toMatchObject({
      ok: false,
      failure: { kind: "refused", refusal: { reason: "host" } },
    });
    // Nothing was sent to the server at all.
    expect(reached).toBe(false);
  });

  it("refuses a non-http scheme and a non-web port before any request", async () => {
    let reached = false;
    const fixture = await serve((_request, response) => {
      reached = true;
      response.writeHead(200, HTML);
      response.end("<html></html>");
    });

    const file = await fetchPage("file:///etc/passwd", { bounds: boundsFor(fixture) });
    const odd = await fetchPage(`http://${PUBLIC_NAME}:6379/`, {
      bounds: boundsFor(fixture),
      resolve: resolveToLoopback,
      permittedAddresses: [LOOPBACK],
    });

    expect(file).toMatchObject({ ok: false, failure: { kind: "refused", refusal: { reason: "scheme" } } });
    expect(odd).toMatchObject({ ok: false, failure: { kind: "refused", refusal: { reason: "port" } } });
    expect(reached).toBe(false);
  });

  it("follows a redirect chain and reports every hop", async () => {
    const fixture = await serve((request, response) => {
      const { pathname } = new URL(request.url ?? "/", "http://localhost");
      if (pathname === "/old") {
        response.writeHead(301, { location: "/moved" });
        response.end();
        return;
      }
      if (pathname === "/moved") {
        response.writeHead(302, { location: "/p/helmet" });
        response.end();
        return;
      }
      response.writeHead(200, HTML);
      response.end("<html><body><p>Helmet</p></body></html>");
    });

    const outcome = await fetchFixture(fixture, "/old");

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.page.url).toBe(fixture.url("/p/helmet"));
    expect(outcome.page.chain).toEqual([
      fixture.url("/old"),
      fixture.url("/moved"),
      fixture.url("/p/helmet"),
    ]);
  });

  it("refuses a redirect that points at a private destination, before requesting it", async () => {
    let privateHits = 0;
    const fixture = await serve((request, response) => {
      const { pathname } = new URL(request.url ?? "/", "http://localhost");
      if (pathname === "/private") {
        privateHits += 1;
        response.writeHead(200, HTML);
        response.end("<html><body>internal</body></html>");
        return;
      }
      // A public page redirecting to the cloud metadata service: the classic
      // SSRF bypass of a check that only looks at the first URL.
      response.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
      response.end();
    });

    const outcome = await fetchFixture(fixture, "/start");

    expect(outcome).toMatchObject({
      ok: false,
      failure: { kind: "refused", refusal: { target: "169.254.169.254", reason: "address" } },
    });
    expect(privateHits).toBe(0);
  });

  it("re-validates the scheme of a redirect, so a hop cannot leave http", async () => {
    const fixture = await serve((_request, response) => {
      response.writeHead(302, { location: "file:///etc/passwd" });
      response.end();
    });

    const outcome = await fetchFixture(fixture, "/start");
    expect(outcome).toMatchObject({ ok: false, failure: { kind: "refused", refusal: { reason: "scheme" } } });
  });

  it("refuses a redirect chain longer than the limit, without following the last hop", async () => {
    let requests = 0;
    const fixture = await serve((request, response) => {
      requests += 1;
      const { pathname } = new URL(request.url ?? "/", "http://localhost");
      const hop = Number(pathname.replace("/hop-", ""));
      response.writeHead(302, { location: `/hop-${hop + 1}` });
      response.end();
    });

    const outcome = await fetchFixture(fixture, "/hop-0", { maxRedirects: 2 });

    expect(outcome).toMatchObject({ ok: false, failure: { kind: "too_many_redirects", limit: 2 } });
    // The first URL plus the two permitted hops: the fourth is never requested.
    expect(requests).toBe(3);
  });

  it("refuses a body larger than the cap, and stops downloading it", async () => {
    const fixture = await serve((_request, response) => {
      response.writeHead(200, HTML);
      // A declared length above the cap: refused before any of it is read.
      response.end("x".repeat(5_000));
    });

    const outcome = await fetchFixture(fixture, "/huge", { maxResponseBytes: 1_000 });

    expect(outcome).toMatchObject({ ok: false, failure: { kind: "too_large", limit: 1_000 } });
  });

  it("enforces the cap on a chunked body that declares no length", async () => {
    const fixture = await serve((_request, response) => {
      // No Content-Length: the cap must be enforced as the bytes arrive.
      response.writeHead(200, { "content-type": "text/html", "transfer-encoding": "chunked" });
      const chunk = "y".repeat(512);
      let written = 0;
      const write = () => {
        while (written < 20_000) {
          written += chunk.length;
          if (!response.write(chunk)) {
            response.once("drain", write);
            return;
          }
        }
        response.end();
      };
      write();
    });

    const outcome = await fetchFixture(fixture, "/chunked", { maxResponseBytes: 1_000 });

    expect(outcome).toMatchObject({ ok: false, failure: { kind: "too_large" } });
    if (outcome.ok) return;
    expect(outcome.failure.kind === "too_large" && outcome.failure.bytes).toBeGreaterThan(1_000);
  });

  it("gives up on a response that stalls, within the timeout", async () => {
    const fixture = await serve((_request, response) => {
      response.writeHead(200, HTML);
      response.write("<html><body>");
      // Never finishes: the whole retrieval must end on its own deadline.
    });

    const startedAt = Date.now();
    const outcome = await fetchFixture(fixture, "/slow", { timeoutMs: 250 });

    expect(outcome).toMatchObject({ ok: false, failure: { kind: "timeout", limitMs: 250 } });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("treats a non-HTML body as a page with no text, without reading it", async () => {
    const fixture = await serve((_request, response) => {
      response.writeHead(200, { "content-type": "application/pdf" });
      response.end("%PDF-1.7\n".repeat(1000));
    });

    const outcome = await fetchFixture(fixture, "/catalogue.pdf");

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.page.mediaType).toBe("application/pdf");
    expect(outcome.page.bytes.byteLength).toBe(0);
  });

  it("reports a name that does not resolve as a failure, not a refusal", async () => {
    const fixture = await serve((_request, response) => {
      response.writeHead(200, HTML);
      response.end("<html></html>");
    });

    const outcome = await fetchPage(fixture.url("/p"), {
      bounds: boundsFor(fixture),
      resolve: async () => [],
    });

    expect(outcome).toMatchObject({ ok: false, failure: { kind: "failed", detail: "name did not resolve" } });
  });

  it("reports a URL that is not a URL at all", async () => {
    const outcome = await fetchPage("not a url", { bounds: DEFAULT_FETCH_BOUNDS });
    expect(outcome).toMatchObject({ ok: false, failure: { kind: "invalid_url" } });
  });

  it("identifies itself honestly and never sends credentials", async () => {
    let userAgent: string | undefined;
    let authorization: string | undefined;
    const fixture = await serve((request, response) => {
      userAgent = request.headers["user-agent"];
      authorization = request.headers.authorization;
      response.writeHead(200, HTML);
      response.end("<html></html>");
    });

    await fetchFixture(fixture, "/p");

    expect(userAgent).toContain("shopping-assistant");
    expect(authorization).toBeUndefined();
  });
});
