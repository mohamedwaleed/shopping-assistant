// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A user's private workspace plus their role in it. Workspace membership is
 * resolved from the database, never from a caller-supplied identifier: a
 * request body or query parameter naming another workspace grants nothing
 * (see docs/adr/0005 and docs/adr/0009).
 */
export interface WorkspaceMembership {
  workspaceId: string;
  role: "owner" | "member";
}

/** Installation administrator manages access and shared configuration. */
export interface InstallationAdministrator {
  userId: string;
  /** ISO timestamp of the one-time setup claim. */
  claimedAt: string;
}

export type SignUpRequest = {
  name: string;
  email: string;
  /** False when the transport could not establish an authenticated session. */
  sessionEstablished: boolean;
};

export type SignInRequest = {
  email: string;
  password: string;
  sessionEstablished: boolean;
};

export type SignOutRequest = {
  sessionRevoked: boolean;
};

/**
 * What a transport adapter reports after the identity library handled a
 * request. Core validates admission and workspace ownership; the adapter stays
 * responsible for credential verification and cookie mechanics.
 */
export interface AuthenticationReport {
  userId: string;
  /** ISO timestamp after which the session must not be accepted. */
  sessionExpiresAt: string;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  workspace: WorkspaceMembership;
}

export interface SetupState {
  /** False until the one-time setup token has created the first administrator. */
  complete: boolean;
  /** Setup can still be claimed; an administrator already exists afterwards. */
  claimable: boolean;
}

export interface SetupClaim {
  user: AuthenticatedUser;
  administrator: InstallationAdministrator;
}

export type SetupClaimRequest = {
  token: string;
  name: string;
  email: string;
  password: string;
  workspaceName: string;
  sessionEstablished: boolean;
};
