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
  secondFactorCode?: string;
};

export interface TwoFactorEnrollment {
  /** Enter this base32 secret in an authenticator app; it is not persisted in recovery-code responses. */
  secret: string;
  otpauthUrl: string;
}

export interface TwoFactorRecoveryCodes { recoveryCodes: string[]; }

export type SignOutRequest = {
  sessionRevoked: boolean;
};

/**
 * A stored session as core accepts it. The inactivity window moves with use;
 * `createdAt` never does, so the absolute maximum still applies.
 */
export interface SessionReport {
  userId: string;
  sessionId: string;
  /** ISO timestamp after which the session must not be accepted. */
  expiresAt: string;
  createdAt: string;
  lastActiveAt: string;
}

/** One signed-in device, described by what the session row recorded. */
export interface DeviceSession {
  id: string;
  current: boolean;
  /** ISO timestamp of the sign-in that created the session. */
  createdAt: string;
  /** ISO timestamp of the last admitted use. */
  lastActiveAt: string;
  /** ISO timestamp after which the session must not be accepted. */
  expiresAt: string;
  ipAddress: string | null;
  userAgent: string | null;
}

export interface DeviceList {
  sessions: DeviceSession[];
}

/**
 * How recently the caller proved they are present. The clock starts at the
 * sign-in that created the session and never restarts on ordinary use, so a
 * continuously-used session does not stay recently authenticated.
 */
export interface RecentAuthentication {
  recent: boolean;
  /** ISO timestamp of the sign-in that authenticated the current session. */
  authenticatedAt: string;
  /** Seconds of recent authentication the installation requires. */
  windowSeconds: number;
}

export type RevokeSessionRequest = {
  /** Session to revoke; the stored row must belong to the caller. */
  sessionId: string;
};

export type ChangePasswordRequest = {
  currentPassword: string;
  newPassword: string;
  secondFactorCode?: string;
};

export type ChangeEmailRequest = {
  newEmail: string;
};

export type CreateCredentialAccountRequest = {
  name: string;
  email: string;
  password: string;
};

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
