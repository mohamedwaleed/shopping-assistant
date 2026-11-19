// SPDX-License-Identifier: AGPL-3.0-or-later
export { createShoppingCore, type ShoppingCore } from "./core";
export { err, ok, type CoreError, type Result } from "./errors";
export {
  isAuthorized,
  principalForUser,
  type Capability,
  type Principal,
} from "./principal";
export {
  createAuthentication,
  principalFor,
  RECENT_AUTHENTICATION_SECONDS,
  SESSION_ABSOLUTE_SECONDS,
  SESSION_INACTIVITY_SECONDS,
  type AccountProvisioner,
  type Authentication,
  type AuthDependencies,
  type CredentialChanger,
} from "./auth/authentication";
export {
  hashSetupToken,
  readSetupToken,
  SETUP_TOKEN_ENV,
  setupTokenMatches,
  type SetupTokenSource,
} from "./auth/setup-token";
export {
  type AuthenticatedUser,
  type ChangeEmailRequest,
  type ChangePasswordRequest,
  type CreateCredentialAccountRequest,
  type DeviceList,
  type DeviceSession,
  type InstallationAdministrator,
  type RecentAuthentication,
  type RevokeSessionRequest,
  type SessionReport,
  type SetupClaim,
  type SetupClaimRequest,
  type SetupState,
  type SignInRequest,
  type SignOutRequest,
  type SignUpRequest,
  type WorkspaceMembership,
} from "./auth/types";
export {
  createMailer,
  DIAGNOSTIC_COOLDOWN_MS,
  failureStageFromCode,
  INSTALLATION_SECRET_ENV,
  MIN_INSTALLATION_SECRET_LENGTH,
  type MailDelivery,
  type MailDeliveryView,
  type MailError,
  type MailFailureStage,
  type Mailer,
  type MailerDependencies,
  type MailMessage,
  type MailSettingsView,
  type MailTransport,
  type SmtpConnection,
  type SmtpSettingsInput,
  type SmtpSettingsView,
} from "./mail/mailer";
export { nodemailerTransport } from "./mail/nodemailer-transport";
export { openSecret, sealSecret } from "./mail/sealed-secret";
export {
  type VariantOffer,
  type VariantOfferDetail,
  type VariantPrice,
} from "./catalogue";
export { addMoney } from "./money";
