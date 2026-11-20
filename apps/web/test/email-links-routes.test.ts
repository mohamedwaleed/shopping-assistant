// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EMAIL_LINK_PATHS } from "@shopping/core";

// Every link an invitation, recovery or address-change email delivers has to
// land on a screen that exists. The paths come from core, which records them,
// and the adapter builds the delivered URLs from them; the app's own router is
// the file system under `app/`, so this asserts each recorded path resolves to
// a page route — not to a route handler, and not to a 404 (which is exactly
// what invitation links did before these screens shipped).

const appRoot = fileURLToPath(new URL("../app/", import.meta.url));

/** The `page` module a Next.js app-router path resolves to, if it exists. */
function pageFor(pathname: string): string | null {
  const segments = pathname.split("/").filter(Boolean);
  const candidate = `${appRoot}${segments.length ? `${segments.join("/")}/` : ""}page.tsx`;
  return existsSync(candidate) ? candidate : null;
}

describe("email link paths resolve to screens", () => {
  const purposes = Object.keys(EMAIL_LINK_PATHS) as Array<keyof typeof EMAIL_LINK_PATHS>;

  it("records one path for each flow that delivers a link", () => {
    expect(purposes.sort()).toEqual(["email-change", "invitation", "password-reset"]);
  });

  it.each(purposes)("%s links open a page route", (purpose) => {
    const pathname = EMAIL_LINK_PATHS[purpose];
    expect(pathname.startsWith("/"), `${pathname} must be absolute`).toBe(true);
    expect(pageFor(pathname), `${pathname} has no page route`).not.toBeNull();
  });

  it("keeps the delivered link shape the screens read", () => {
    // Core appends `?email=…&token=…` to the base URL, and each screen reads
    // those two query parameters. A path that already carries a query would
    // break that, so the recorded paths are bare.
    for (const purpose of purposes) {
      expect(EMAIL_LINK_PATHS[purpose]).not.toContain("?");
    }
  });
});
