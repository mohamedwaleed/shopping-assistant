// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Knex } from "knex";
import { err, ok, type Result } from "../errors";
import { isAuthorized, principalForUser, type Principal } from "../principal";
import { hashSetupToken, readSetupToken, setupTokenMatches } from "./setup-token";
import type {
  AuthenticatedUser,
  ChangeEmailRequest,
  ChangePasswordRequest,
  CreateCredentialAccountRequest,
  DeviceList,
  DeviceSession,
  InstallationAdministrator,
  RecentAuthentication,
  RevokeSessionRequest,
  SessionReport,
  SetupClaim,
  SetupClaimRequest,
  SetupState,
  SignInRequest,
  SignOutRequest,
  SignUpRequest,
  WorkspaceMembership,
} from "./types";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 10;

/**
 * Session lifetime. The inactivity window moves with every admitted use of a
 * stored session; the absolute maximum is counted from creation, so an active
 * session still ends thirty days after sign-in.
 */
export const SESSION_INACTIVITY_SECONDS = 7 * 24 * 60 * 60;
export const SESSION_ABSOLUTE_SECONDS = 30 * 24 * 60 * 60;
/**
 * Password changes and credential creation need a session authenticated this
 * recently, counted from the sign-in that created it.
 */
export const RECENT_AUTHENTICATION_SECONDS = 5 * 60;

export interface AuthDependencies {
  db: Knex;
  /** Installation-held token source; defaults to the process environment. */
  setupToken?: () => ReturnType<typeof readSetupToken>;
  now?: () => Date;
}

/**
 * Identity library work the core cannot perform itself: Better Auth owns
 * credential verification and session creation. Adapters implement this and
 * report the outcome; core still decides whether access is admitted.
 */
export interface AccountProvisioner {
  createCredentialAccount(input: { name: string; email: string; password: string }): Promise<{ userId: string }>;
  deleteIdentity(userId: string): Promise<void>;
  verifyCredentials(input: { email: string; password: string }): Promise<{ userId: string } | null>;
}

/**
 * Credential work core authorizes but cannot perform: the identity library
 * hashes passwords and validates the current one. An adapter reports whether
 * it accepted the change; core has already decided who may ask.
 */
export interface CredentialChanger {
  changePassword(input: {
    userId: string;
    /** Password the caller presented, which the adapter verifies. */
    currentPassword: string;
    newPassword: string;
    /** Session whose stored row must stay valid. */
    sessionId: string;
  }): Promise<void>;
  changeEmail(input: { userId: string; newEmail: string }): Promise<void>;
  /**
   * Replace a password without knowing the current one. Only a spent,
   * unexpired link authorizes this: the password reset and the confirmed
   * email-address change both come through here.
   */
  setPassword(input: { userId: string; newPassword: string }): Promise<void>;
}

/**
 * Sends the email-address change confirmation. Core decides who may ask and
 * when; the account-link module owns the expiring single-use link, so an
 * address only becomes the sign-in identity once its mailbox confirms it.
 */
export interface EmailChangeRequester {
  requestEmailChange(
    principal: Principal,
    newEmail: string,
  ): Promise<Result<{ confirmationSent: true }>>;
}

export interface Authentication {
  getSetupState(): Promise<Result<SetupState>>;
  claimSetup(
    request: SetupClaimRequest,
    provisioner: AccountProvisioner,
  ): Promise<Result<SetupClaim>>;
  admission(principal: Principal): Promise<Result<AuthenticatedUser>>;
  /** Accept a stored session, apply its lifetime and record the use. */
  requireSession(userId: string, sessionId: string): Promise<Result<SessionReport>>;
  listSessions(principal: Principal): Promise<Result<DeviceList>>;
  revokeSession(
    principal: Principal,
    request: RevokeSessionRequest,
  ): Promise<Result<{ revoked: number }>>;
  revokeAllSessions(principal: Principal): Promise<Result<{ revoked: number }>>;
  recentAuthentication(principal: Principal): Promise<Result<RecentAuthentication>>;
  changePassword(
    principal: Principal,
    request: ChangePasswordRequest,
    credentials: CredentialChanger,
  ): Promise<Result<{ changed: true; otherSessionsRevoked: number }>>;
  changeEmail(
    principal: Principal,
    request: ChangeEmailRequest,
    /** Sends the confirmation link to the new address; core never switches it directly. */
    links: EmailChangeRequester,
  ): Promise<Result<{ confirmationSent: true }>>;
  createCredentialAccount(
    principal: Principal,
    request: CreateCredentialAccountRequest,
    provisioner: AccountProvisioner,
  ): Promise<Result<{ userId: string }>>;
  signUp(
    request: SignUpRequest,
    provisioner: AccountProvisioner,
  ): Promise<Result<AuthenticatedUser>>;
  signIn(
    request: SignInRequest,
    provisioner: AccountProvisioner,
  ): Promise<Result<AuthenticatedUser>>;
  signOut(request: SignOutRequest): Promise<Result<{ signedOut: true }>>;
  administrator(userId: string): Promise<Result<InstallationAdministrator>>;
}

interface UserRow {
  id: string;
  name: string;
  email: string;
}

interface InstallationRow {
  setup_completed_at: Date | null;
  setup_token_hash: string | null;
  setup_administrator_user_id: string | null;
}

interface SessionRow {
  id: string;
  user_id: string;
  token: string;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
  ip_address: string | null;
  user_agent: string | null;
}

export function createAuthentication(deps: AuthDependencies): Authentication {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const setupToken = deps.setupToken ?? (() => readSetupToken());

  async function installation(): Promise<InstallationRow> {
    const row = await db("installation").where({ id: 1 }).first();
    if (!row) throw new Error("installation row is missing; run migrations");
    return row as InstallationRow;
  }

  async function membershipOf(userId: string): Promise<WorkspaceMembership | null> {
    const row = await db("workspace_memberships")
      .where({ user_id: userId })
      .select("workspace_id", "role")
      .first();
    if (!row) return null;
    return { workspaceId: row.workspace_id, role: row.role };
  }

  async function authenticatedUser(userId: string): Promise<Result<AuthenticatedUser>> {
    const user = (await db("user").where({ id: userId }).first()) as UserRow | undefined;
    if (!user) return err({ kind: "not-found", resource: "user", id: userId });
    const workspace = await membershipOf(userId);
    if (!workspace) return err({ kind: "forbidden", capability: "workspace.read" });
    return ok({ id: user.id, email: user.email, name: user.name, workspace });
  }

  async function setupState(): Promise<SetupState> {
    const row = await installation();
    const token = setupToken();
    return {
      complete: row.setup_completed_at !== null,
      claimable: row.setup_completed_at === null && token.kind === "configured",
    };
  }

  async function claimSetup(
    request: SetupClaimRequest,
    provisioner: AccountProvisioner,
  ): Promise<Result<SetupClaim>> {
    const token = setupToken();
    if (token.kind === "missing") return err({ kind: "setup-unavailable" });

    const name = request.name.trim();
    const email = request.email.trim().toLowerCase();
    const workspaceName = request.workspaceName.trim() || "Private workspace";
    if (!name) {
      return err({ kind: "invalid-input", field: "name", message: "name is required" });
    }
    if (!EMAIL_PATTERN.test(email)) {
      return err({ kind: "invalid-input", field: "email", message: "email must be a valid address" });
    }
    if (!request.sessionEstablished) {
      return err({ kind: "forbidden", capability: "auth.session" });
    }
    if (request.password.length < MIN_PASSWORD_LENGTH) {
      return err({
        kind: "invalid-input",
        field: "password",
        message: `password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      });
    }

    const state = await installation();
    if (state.setup_completed_at !== null) return err({ kind: "setup-already-complete" });

    const presentedToken = request.token.trim();
    if (!presentedToken || !setupTokenMatches(presentedToken, token.token)) {
      return err({ kind: "invalid-setup-token" });
    }

    const existing = (await db("user").where({ email }).first()) as UserRow | undefined;
    if (existing) {
      return err({
        kind: "invalid-input",
        field: "email",
        message: "email is already in use",
      });
    }

    // Claim the installation before creating anything: the conditional update
    // is the single-writer gate, so a replayed or concurrent claim loses here
    // and leaves no orphaned administrator or workspace behind.
    const claimedAt = now();
    const claimed = await db("installation")
      .where({ id: 1 })
      .whereNull("setup_completed_at")
      .update({
        setup_completed_at: claimedAt,
        setup_token_hash: hashSetupToken(token.token),
        updated_at: claimedAt,
      });
    if (claimed !== 1) return err({ kind: "setup-already-complete" });

    let createdUserId: string;
    try {
      const created = await provisioner.createCredentialAccount({
        name,
        email,
        password: request.password,
      });
      createdUserId = created.userId;
    } catch (error) {
      await db("installation")
        .where({ id: 1 })
        .update({ setup_completed_at: null, setup_token_hash: null, updated_at: now() });
      throw error;
    }

    const user = (await db("user").where({ id: createdUserId }).first()) as UserRow;
    const [workspace] = await db("workspaces")
      .insert({ name: workspaceName, created_by_user_id: user.id })
      .returning("id");
    await db("workspace_memberships").insert({
      workspace_id: workspace.id,
      user_id: user.id,
      role: "owner",
    });
    await db("installation")
      .where({ id: 1 })
      .update({ setup_administrator_user_id: user.id });

    return ok({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        workspace: { workspaceId: workspace.id, role: "owner" },
      },
      administrator: { userId: user.id, claimedAt: claimedAt.toISOString() },
    });
  }

  async function admission(principal: Principal): Promise<Result<AuthenticatedUser>> {
    if (principal.kind === "anonymous") {
      return err({ kind: "forbidden", capability: "workspace.read" });
    }
    if (!isAuthorized(principal, "workspace.read")) {
      return err({ kind: "forbidden", capability: "workspace.read" });
    }
    if (!UUID_PATTERN.test(principal.workspaceId)) {
      return err({
        kind: "invalid-input",
        field: "workspaceId",
        message: "workspaceId must be a UUID",
      });
    }
    const user = await authenticatedUser(principal.userId);
    if (!user.ok) return user;
    if (user.value.workspace.workspaceId !== principal.workspaceId) {
      return err({ kind: "forbidden", capability: "workspace.read" });
    }
    return user;
  }

  async function sessionRow(userId: string, sessionId: string): Promise<SessionRow | null> {
    if (!userId || !sessionId) return null;
    const row = await db("session").where({ id: sessionId, user_id: userId }).first();
    return (row as SessionRow | undefined) ?? null;
  }

  /**
   * The only place a stored session is accepted. An idle session ends seven
   * days after its last use, an active one ends thirty days after sign-in, and
   * an accepted use moves the inactivity window and records the device's
   * latest activity. Expired rows are deleted so the cookie cannot be replayed.
   */
  async function requireSession(
    userId: string,
    sessionId: string,
  ): Promise<Result<SessionReport>> {
    const row = await sessionRow(userId, sessionId);
    if (!row) return err({ kind: "invalid-credentials" });

    const at = now();
    const createdAt = row.created_at.getTime();
    const lastActiveAt = row.updated_at.getTime();
    const absoluteEnd = createdAt + SESSION_ABSOLUTE_SECONDS * 1000;
    const idleEnd = lastActiveAt + SESSION_INACTIVITY_SECONDS * 1000;
    if (at.getTime() >= absoluteEnd || at.getTime() >= idleEnd) {
      await db("session").where({ id: row.id, user_id: userId }).delete();
      return err({ kind: "invalid-credentials" });
    }

    const expiresAt = new Date(Math.min(idleEnd, absoluteEnd));
    await db("session").where({ id: row.id, user_id: userId }).update({ updated_at: at });
    return ok({
      userId,
      sessionId: row.id,
      expiresAt: expiresAt.toISOString(),
      createdAt: row.created_at.toISOString(),
      lastActiveAt: at.toISOString(),
    });
  }

  async function deviceSessions(userId: string): Promise<SessionRow[]> {
    const at = now().getTime();
    const rows = (await db("session").where({ user_id: userId })) as SessionRow[];
    return rows
      .filter(
        (row) =>
          at < row.created_at.getTime() + SESSION_ABSOLUTE_SECONDS * 1000 &&
          at < row.updated_at.getTime() + SESSION_INACTIVITY_SECONDS * 1000,
      )
      .sort((left, right) => right.updated_at.getTime() - left.updated_at.getTime());
  }

  /**
   * Only an admitted caller acting under their own live session may touch
   * devices or credentials. Anonymous callers and principals naming another
   * workspace are refused before any session row is read.
   */
  async function admittedUser(principal: Principal): Promise<Result<AuthenticatedUser>> {
    const admitted = await admission(principal);
    if (!admitted.ok) return admitted;
    if (principal.kind === "anonymous") {
      return err({ kind: "forbidden", capability: "workspace.read" });
    }
    // Every device and credential action runs under the caller's own session,
    // so a stale or revoked session cannot drive a change either.
    const session = await requireSession(admitted.value.id, principal.sessionId);
    if (!session.ok) return session;
    return admitted;
  }

  async function listSessions(principal: Principal): Promise<Result<DeviceList>> {
    const admitted = await admittedUser(principal);
    if (!admitted.ok) return admitted;
    const currentSessionId = principal.kind === "anonymous" ? "" : principal.sessionId;

    const sessions: DeviceSession[] = (await deviceSessions(admitted.value.id)).map((row) => ({
      id: row.id,
      current: row.id === currentSessionId,
      createdAt: row.created_at.toISOString(),
      lastActiveAt: row.updated_at.toISOString(),
      expiresAt: new Date(
        Math.min(
          row.updated_at.getTime() + SESSION_INACTIVITY_SECONDS * 1000,
          row.created_at.getTime() + SESSION_ABSOLUTE_SECONDS * 1000,
        ),
      ).toISOString(),
      ipAddress: row.ip_address,
      userAgent: row.user_agent,
    }));
    return ok({ sessions });
  }

  async function revokeSession(
    principal: Principal,
    request: RevokeSessionRequest,
  ): Promise<Result<{ revoked: number }>> {
    const admitted = await admittedUser(principal);
    if (!admitted.ok) return admitted;

    const sessionId = request.sessionId.trim();
    if (!sessionId) {
      return err({ kind: "invalid-input", field: "sessionId", message: "sessionId is required" });
    }
    // The user id is part of the delete so another account's session is never
    // reachable, even when its identifier leaks.
    const revoked = await db("session")
      .where({ id: sessionId, user_id: admitted.value.id })
      .delete();
    if (revoked === 0) return err({ kind: "not-found", resource: "session", id: sessionId });
    return ok({ revoked });
  }

  async function revokeAllSessions(principal: Principal): Promise<Result<{ revoked: number }>> {
    const admitted = await admittedUser(principal);
    if (!admitted.ok) return admitted;
    return ok({ revoked: await db("session").where({ user_id: admitted.value.id }).delete() });
  }

  /**
   * Recent authentication is measured from when the session authenticated, not
   * from when it was last used: every admitted request moves `updated_at`, so
   * that would let a continuously-used session, and with it a hijacked cookie,
   * pass the gate forever. The session row is created by the sign-in that
   * issued it, so `created_at` is that moment. The window is short enough that
   * a hijacked cookie cannot be spent without the password.
   */
  async function recentAuthentication(
    principal: Principal,
  ): Promise<Result<RecentAuthentication>> {
    if (principal.kind === "anonymous") {
      return err({ kind: "forbidden", capability: "workspace.read" });
    }
    const session = await sessionRow(principal.userId, principal.sessionId);
    const admitted = await admittedUser(principal);
    if (!admitted.ok) return admitted;
    if (!session) return err({ kind: "invalid-credentials" });

    const elapsed = now().getTime() - session.created_at.getTime();
    return ok({
      recent: elapsed < RECENT_AUTHENTICATION_SECONDS * 1000,
      authenticatedAt: session.created_at.toISOString(),
      windowSeconds: RECENT_AUTHENTICATION_SECONDS,
    });
  }

  async function changePassword(
    principal: Principal,
    request: ChangePasswordRequest,
    credentials: CredentialChanger,
  ): Promise<Result<{ changed: true; otherSessionsRevoked: number }>> {
    // The recent-authentication gate comes first, so a stale session is told
    // to sign in again rather than refused as a credential problem.
    const recent = await recentAuthentication(principal);
    if (!recent.ok) return recent;
    const admitted = await admittedUser(principal);
    if (!admitted.ok) return admitted;

    if (!request.currentPassword) {
      return err({
        kind: "invalid-input",
        field: "currentPassword",
        message: "currentPassword is required",
      });
    }
    if (request.newPassword.length < MIN_PASSWORD_LENGTH) {
      return err({
        kind: "invalid-input",
        field: "newPassword",
        message: `password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      });
    }

    if (!recent.value.recent) return err({ kind: "reauthentication-required" });

    const sessionId = principal.kind === "anonymous" ? "" : principal.sessionId;
    // The identity library verifies the current password and replaces the
    // hash. Every other device loses its session, so a leaked password cannot
    // keep working after the owner changes it. A refusal there (a wrong current
    // password) is the caller's mistake, not a server failure.
    try {
      await credentials.changePassword({
        userId: admitted.value.id,
        currentPassword: request.currentPassword,
        newPassword: request.newPassword,
        sessionId,
      });
    } catch {
      return err({ kind: "invalid-credentials" });
    }
    const otherSessionsRevoked = await db("session")
      .where({ user_id: admitted.value.id })
      .whereNot({ id: sessionId })
      .delete();
    return ok({ changed: true, otherSessionsRevoked });
  }

  async function changeEmail(
    principal: Principal,
    request: ChangeEmailRequest,
    links: EmailChangeRequester,
  ): Promise<Result<{ confirmationSent: true }>> {
    // The recent-authentication gate comes first, so a stale session is told
    // to sign in again rather than refused as an address problem.
    const recent = await recentAuthentication(principal);
    if (!recent.ok) return recent;
    const admitted = await admittedUser(principal);
    if (!admitted.ok) return admitted;
    if (!recent.value.recent) return err({ kind: "reauthentication-required" });

    // The new address has to prove it is reachable before it becomes the
    // sign-in identity, so this only sends the confirmation link.
    return links.requestEmailChange(principal, request.newEmail);
  }

  async function createCredentialAccount(
    principal: Principal,
    request: CreateCredentialAccountRequest,
    provisioner: AccountProvisioner,
  ): Promise<Result<{ userId: string }>> {
    // The recent-authentication gate comes first, so a stale session is told
    // to sign in again rather than refused as a credential problem.
    const recent = await recentAuthentication(principal);
    if (!recent.ok) return recent;
    const admitted = await admittedUser(principal);
    if (!admitted.ok) return admitted;
    if (!isAuthorized(principal, "installation.manage")) {
      return err({ kind: "forbidden", capability: "installation.manage" });
    }

    const name = request.name.trim();
    const email = request.email.trim().toLowerCase();
    if (!name) {
      return err({ kind: "invalid-input", field: "name", message: "name is required" });
    }
    if (!EMAIL_PATTERN.test(email)) {
      return err({ kind: "invalid-input", field: "email", message: "email must be a valid address" });
    }
    if (request.password.length < MIN_PASSWORD_LENGTH) {
      return err({
        kind: "invalid-input",
        field: "password",
        message: `password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      });
    }

    if (!recent.value.recent) return err({ kind: "reauthentication-required" });

    const created = await provisioner.createCredentialAccount({
      name,
      email,
      password: request.password,
    });
    return ok({ userId: created.userId });
  }

  async function signUp(
    request: SignUpRequest,
    provisioner: AccountProvisioner,
  ): Promise<Result<AuthenticatedUser>> {
    // Public registration stays closed: only the one-time setup claim creates
    // the first administrator and workspace.
    void request;
    void provisioner;
    return err({ kind: "registration-closed" });
  }

  async function signIn(
    request: SignInRequest,
    provisioner: AccountProvisioner,
  ): Promise<Result<AuthenticatedUser>> {
    const email = request.email.trim().toLowerCase();
    if (!EMAIL_PATTERN.test(email)) {
      return err({ kind: "invalid-input", field: "email", message: "email must be a valid address" });
    }
    if (request.password.length < MIN_PASSWORD_LENGTH) {
      return err({ kind: "invalid-credentials" });
    }
    const verified = await provisioner.verifyCredentials({ email, password: request.password });
    if (!verified) return err({ kind: "invalid-credentials" });
    if (!request.sessionEstablished) return err({ kind: "forbidden", capability: "auth.session" });

    const admitted = await authenticatedUser(verified.userId);
    if (!admitted.ok) return admitted;
    return admitted;
  }

  async function signOut(request: SignOutRequest): Promise<Result<{ signedOut: true }>> {
    if (!request.sessionRevoked) return err({ kind: "forbidden", capability: "auth.session" });
    return ok({ signedOut: true });
  }

  async function administrator(userId: string): Promise<Result<InstallationAdministrator>> {
    const row = await installation();
    if (!row.setup_completed_at || row.setup_administrator_user_id !== userId) {
      return err({ kind: "forbidden", capability: "installation.manage" });
    }
    return ok({ userId, claimedAt: row.setup_completed_at.toISOString() });
  }

  return {
    getSetupState: async () => ok(await setupState()),
    claimSetup,
    admission,
    requireSession,
    listSessions,
    revokeSession,
    revokeAllSessions,
    recentAuthentication,
    changePassword,
    changeEmail,
    createCredentialAccount,
    signUp,
    signIn,
    signOut,
    administrator,
  };
}

/** Principal for an admitted user, ready for shopping operations. */
export async function principalFor(
  authentication: Authentication,
  user: AuthenticatedUser,
  sessionId: string,
): Promise<Principal> {
  const admin = await authentication.administrator(user.id);
  return principalForUser(user.id, user.workspace, admin.ok, sessionId);
}
