// SPDX-License-Identifier: AGPL-3.0-or-later

/** One shopper admitted by an invitation, in the private workspace it created. */
export interface InvitedShopper {
  user: {
    id: string;
    name: string;
    email: string;
    workspace: { workspaceId: string; role: "owner" | "member" };
  };
}

export type InviteRequest = {
  email: string;
  name: string;
};

export type AcceptInvitationRequest = {
  token: string;
  name: string;
  password: string;
};

export type RequestPasswordResetRequest = {
  email: string;
};

export type ResetPasswordRequest = {
  token: string;
  newPassword: string;
};

export type ConfirmEmailChangeRequest = {
  token: string;
};

/**
 * The only answer a password-recovery request ever gets. It is the same for a
 * known address, an unknown address and a delivery that failed, so the
 * response cannot be used to discover which accounts exist.
 */
export interface PasswordResetAccepted {
  accepted: true;
}

export interface PasswordResetOutcome {
  reset: true;
  /** Sessions of that account that the reset revoked. */
  sessionsRevoked: number;
}

/**
 * An email-address change only ever reports that a confirmation was sent. The
 * identity switches when the new address is confirmed, never before.
 */
export interface EmailChangeConfirmationSent {
  confirmationSent: true;
}

export interface EmailChangeConfirmed {
  confirmed: true;
  email: string;
}
