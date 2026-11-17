// SPDX-License-Identifier: AGPL-3.0-or-later
export { createShoppingCore, type ShoppingCore } from "./core";
export { err, ok, type CoreError, type Result } from "./errors";
export {
  isAuthorized,
  type Capability,
  type Principal,
} from "./principal";
export {
  type VariantOffer,
  type VariantOfferDetail,
  type VariantPrice,
} from "./catalogue";
export { addMoney } from "./money";
