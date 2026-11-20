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
export { authenticatorCode } from "./auth/two-factor";
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
  type TwoFactorEnrollment,
  type TwoFactorRecoveryCodes,
} from "./auth/types";
export {
  createEmailLinkOperations,
  EMAIL_CHANGE_SECONDS,
  INVITATION_SECONDS,
  PASSWORD_RESET_SECONDS,
  type EmailLinkOperations,
  type PasswordRecovery,
} from "./auth/email-links";
export {
  createMailer,
  DIAGNOSTIC_COOLDOWN_MS,
  failureStageFromCode,
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
// nodemailerTransport is deliberately NOT exported from the barrel: nodemailer
// pulls node:net, which breaks any client bundle that imports @shopping/core.
// Import it from "@shopping/core/mail-transport" (server code only).
export { openSecret, sealSecret } from "./mail/sealed-secret";
export {
  type VariantOffer,
  type VariantOfferDetail,
  type VariantPrice,
  type AttributeReview,
} from "./catalogue";
export {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  type AttributeFilter,
  type AttributeProvenance,
  type AttributeStatus,
  type CatalogueSearchQuery,
  type CatalogueSearchResponse,
  type CatalogueSearchResult,
  type FilterOperator,
  type ResultOfferSummary,
  type ResultPrice,
  type SearchMatch,
} from "./catalogue-search";
export {
  analyseQuery,
  MAX_IDENTIFIER_LENGTH,
  MAX_SEARCH_TEXT_LENGTH,
  MAX_SEARCH_TERMS,
  simpleLexemes,
  tokenize,
  trigramSimilarity,
  type AnalysedQuery,
  type QueryExpansion,
  type SearchTerm,
  type VocabularyTerm,
} from "./catalogue-search-query";
export { addMoney, compareMoney } from "./money";
export { createIngestion, type IngestedPage, type IngestionDependencies, type PageFetcher, type PermittedSource, type SourcePolicy } from "./ingestion";
export {
  createModelRegistry,
  diagnosticBounds,
  type ModelRegistry,
  type ModelRegistryDependencies,
} from "./models/model-registry";
export {
  createSecretCipher,
  maskSecret,
  SECRET_ENCRYPTION,
  type SecretCipher,
} from "./models/secret-cipher";
export {
  INSTALLATION_SECRET_ENV,
  MINIMUM_INSTALLATION_SECRET_LENGTH,
} from "./installation-secret";
export {
  DEFAULT_DIAGNOSTIC_BOUNDS,
  MAX_DIAGNOSTIC_CALLS,
  MAX_DIAGNOSTIC_OUTPUT_TOKENS,
  MODEL_PROVIDERS,
  type CapabilityReport,
  type CapabilityState,
  type DiagnosticBounds,
  type EffectiveModelConfigurationView,
  type ModelConfigurationView,
  type ModelConfigurationViewResult,
  type ModelCredentialSummary,
  type ModelProbe,
  type ModelProbeRequest,
  type ModelProvider,
  type ModelRole,
  type ModelTarget,
  type ResolvedModel,
  type SaveModelConfiguration,
  type UsageSource,
} from "./models/types";
export { createBudgetRegistry, type BudgetKind, type BudgetRegistry, type BudgetReservation, type BudgetSettings, type BudgetView } from "./budgets/budget-registry";
export { createChatSessions, type ChatLanguage, type ChatSessions, type SessionMessage, type SessionRequirements, type ShoppingSession } from "./chat";
