// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Knex } from "knex";
import { err, ok, type Result } from "../errors";
import { isAuthorized, principalForUser, type Principal } from "../principal";
import { hashSetupToken, readSetupToken, setupTokenMatches } from "./setup-token";
import type {
  AuthenticatedUser,
  AuthenticationReport,
  InstallationAdministrator,
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

export interface Authentication {
  getSetupState(): Promise<Result<SetupState>>;
  claimSetup(
    request: SetupClaimRequest,
    provisioner: AccountProvisioner,
  ): Promise<Result<SetupClaim>>;
  admission(principal: Principal): Promise<Result<AuthenticatedUser>>;
  requireSession(
    userId: string,
    sessionExpiresAt: string | null,
  ): Promise<Result<AuthenticationReport>>;
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

  async function requireSession(
    userId: string,
    sessionExpiresAt: string | null,
  ): Promise<Result<AuthenticationReport>> {
    if (!userId) return err({ kind: "invalid-credentials" });
    if (!sessionExpiresAt) return err({ kind: "invalid-credentials" });
    const expiresAt = new Date(sessionExpiresAt);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= now().getTime()) {
      return err({ kind: "invalid-credentials" });
    }
    return ok({ userId, sessionExpiresAt: expiresAt.toISOString() });
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
    signUp,
    signIn,
    signOut,
    administrator,
  };
}

/** Principal for an admitted user, ready for shopping operations. */
export async function principalFor(authentication: Authentication, user: AuthenticatedUser): Promise<Principal> {
  const admin = await authentication.administrator(user.id);
  return principalForUser(user.id, user.workspace, admin.ok);
}
