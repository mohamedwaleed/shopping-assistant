// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Trusted identity supplied to core operations. HTTP/MCP adapters build this
 * from authenticated identity; a supplied workspaceId alone never authorizes
 * access (see docs/adr/0005 and .specshape module contracts). Until the
 * workspace-access story lands, catalogue reads are public facts available to
 * every principal kind.
 */
export type Principal =
  | { kind: "anonymous" }
  | { kind: "workspace"; userId: string; workspaceId: string }
  | { kind: "administrator"; userId: string };

export type Capability = "catalogue.read";

const CAPABILITY_PRINCIPALS: Record<Capability, ReadonlyArray<Principal["kind"]>> = {
  "catalogue.read": ["anonymous", "workspace", "administrator"],
};

export function isAuthorized(principal: Principal, capability: Capability): boolean {
  return CAPABILITY_PRINCIPALS[capability].includes(principal.kind);
}
