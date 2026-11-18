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
  type AccountProvisioner,
  type Authentication,
  type AuthDependencies,
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
  type AuthenticationReport,
  type InstallationAdministrator,
  type SetupClaim,
  type SetupClaimRequest,
  type SetupState,
  type SignInRequest,
  type SignOutRequest,
  type SignUpRequest,
  type WorkspaceMembership,
} from "./auth/types";
export {
  type VariantOffer,
  type VariantOfferDetail,
  type VariantPrice,
} from "./catalogue";
export { addMoney } from "./money";
