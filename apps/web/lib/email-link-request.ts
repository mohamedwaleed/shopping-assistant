// SPDX-License-Identifier: AGPL-3.0-or-later
import { EMAIL_LINK_PATHS } from "@shopping/core";
import type { LinkFields } from "@/app/email-link-forms";

/** Search parameters a page receives from the framework. */
export type SearchParams = Record<string, string | string[] | undefined>;

/**
 * Absolute base URL a delivered email link points at, built from the request's
 * own origin and the path core records for that purpose. The screens that
 * complete the flows live at exactly these paths, and
 * `test/email-links-routes.test.ts` fails if one of them stops resolving to a
 * route this app serves.
 */
export function linkBaseUrl(
  purpose: keyof typeof EMAIL_LINK_PATHS,
  origin: string,
): string {
  return `${origin.replace(/\/$/, "")}${EMAIL_LINK_PATHS[purpose]}`;
}

const param = (value: string | string[] | undefined): string =>
  (Array.isArray(value) ? value[0] : value)?.trim() ?? "";

/**
 * The address and token a delivered link carries. Core appends them as
 * `?email=…&token=…`, so every screen that completes a link reads them the
 * same way; a missing token is what tells the screen the visitor did not
 * arrive from a link at all.
 */
export function linkFromSearchParams(params: SearchParams): LinkFields {
  return { email: param(params.email), token: param(params.token) };
}
