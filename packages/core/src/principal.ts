// SPDX-License-Identifier: AGPL-3.0-or-later
import type { WorkspaceMembership } from "./auth/types";

/**
 * Trusted identity supplied to core operations. HTTP/MCP adapters build this
 * from authenticated identity; a supplied workspaceId alone never authorizes
 * access (see docs/adr/0005 and docs/adr/0009). Workspace membership comes from
 * the database, so a principal naming another workspace is not admitted.
 *
 * `sessionId` names the stored session the request presented. Device and
 * credential operations act on that session only, so a principal cannot reach
 * another session's row and a stale one cannot authorize a change.
 */
export type Principal =
  | { kind: "anonymous" }
  | { kind: "workspace"; userId: string; workspaceId: string; sessionId: string }
  | { kind: "administrator"; userId: string; workspaceId: string; sessionId: string };

export type Capability = "catalogue.read" | "catalogue.ingest" | "workspace.read" | "installation.manage";

const CAPABILITY_PRINCIPALS: Record<Capability, ReadonlyArray<Principal["kind"]>> = {
  "catalogue.read": ["anonymous", "workspace", "administrator"],
  "catalogue.ingest": ["workspace", "administrator"],
  "workspace.read": ["workspace", "administrator"],
  "installation.manage": ["administrator"],
};

export function isAuthorized(principal: Principal, capability: Capability): boolean {
  return CAPABILITY_PRINCIPALS[capability].includes(principal.kind);
}

/** Workspace principal for an authenticated, admitted user. */
export function principalForUser(
  userId: string,
  workspace: WorkspaceMembership,
  isInstallationAdministrator: boolean,
  sessionId: string,
): Principal {
  return isInstallationAdministrator
    ? { kind: "administrator", userId, workspaceId: workspace.workspaceId, sessionId }
    : { kind: "workspace", userId, workspaceId: workspace.workspaceId, sessionId };
}
