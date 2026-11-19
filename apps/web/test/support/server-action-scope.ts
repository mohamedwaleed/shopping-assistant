// SPDX-License-Identifier: AGPL-3.0-or-later
import { AsyncLocalStorage } from "node:async_hooks";
import type {
  RequestCookies,
  ResponseCookies,
} from "next/dist/compiled/@edge-runtime/cookies";

/**
 * A server action runs inside a Next.js request scope, which is where
 * `cookies()` and `headers()` find the incoming request and collect the
 * `Set-Cookie` headers the action writes. This runs an action in that scope:
 * the framework's request stores, filled with a request in the `action` phase,
 * which is what makes cookies mutable. The cookies the action wrote are read
 * back from `setCookies`.
 *
 * The framework keeps its stores in `globalThis.AsyncLocalStorage`, falling
 * back to a no-op without it, so the real implementation is installed first.
 * Each store is a `globalThis` slot keyed by the framework version: a copy of
 * the framework that loaded without a real AsyncLocalStorage left a no-op in
 * the slot, so it is replaced, and every copy reads the slot.
 */
export interface ActionScope {
  /** `Set-Cookie` values the action wrote, newest last. */
  setCookies: string[];
  /** What the action redirected with, if it redirected. */
  redirect: unknown;
}

type Store = AsyncLocalStorage<unknown>;

const globals = globalThis as unknown as Record<string | symbol, unknown>;

/** The version suffix the framework puts on its store symbols. */
function storeVersion(): string {
  const found = Object.getOwnPropertySymbols(globals)
    .map((symbol) => symbol.toString())
    .find((symbol) => symbol.startsWith("Symbol(@next/work-async-storage@"));
  if (!found) throw new Error("Next.js request stores are not loaded");
  return found.slice("Symbol(@next/work-async-storage@".length, -1);
}

function nextStore(name: string): Store {
  const key = Symbol.for(`@next/${name}@${storeVersion()}`);
  if (!(globals[key] instanceof AsyncLocalStorage)) {
    globals[key] = new AsyncLocalStorage<unknown>();
  }
  return globals[key] as Store;
}

/** Run `action` the way a submitted form would, with the caller's cookies. */
export async function runServerAction(
  action: () => Promise<unknown>,
  options: { cookie?: string } = {},
): Promise<ActionScope> {
  globals.AsyncLocalStorage = AsyncLocalStorage;

  const { ResponseCookies: Cookies } = (await import(
    "next/dist/compiled/@edge-runtime/cookies"
  )) as typeof import("next/dist/compiled/@edge-runtime/cookies");
  const { MutableRequestCookiesAdapter } = (await import(
    "next/dist/server/web/spec-extension/adapters/request-cookies.js"
  )) as {
    MutableRequestCookiesAdapter: {
      wrap(cookies: RequestCookies, onUpdate: (cookies: string[]) => void): ResponseCookies;
    };
  };

  const headers = new Headers();
  if (options.cookie) headers.set("cookie", options.cookie);

  const setCookies: string[] = [];
  const outgoing = MutableRequestCookiesAdapter.wrap(
    new Cookies(new Headers()) as unknown as RequestCookies,
    (written) => setCookies.push(...written),
  );
  const request = {
    type: "request",
    phase: "action",
    url: { pathname: "/account", search: "" },
    headers,
    cookies: { get: () => undefined, getAll: () => [], has: () => false },
    mutableCookies: outgoing,
    userspaceMutableCookies: outgoing,
    draftMode: { isEnabled: false },
    rootParams: {},
    resumeDataCache: null,
  };

  const work = nextStore("work-async-storage");
  const unit = nextStore("work-unit-async-storage");
  let redirect: unknown;
  try {
    await work.run({ route: "/account" }, () =>
      unit.run(request, () => Promise.resolve(action())),
    );
  } catch (error) {
    // An action ends by redirecting, which the framework turns into a response.
    redirect = error;
  }

  return { setCookies, redirect };
}
