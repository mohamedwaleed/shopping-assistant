// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Knex } from "knex";
import { err, ok, type Result } from "./errors";
import { addMoney } from "./money";
import { isAuthorized, type Principal } from "./principal";

export interface VariantPrice {
  /** Price before delivery, e.g. "559.00". */
  amount: string;
  currency: string;
  shippingAmount: string;
  /** amount + shippingAmount — the delivered total for this observation. */
  deliveredAmount: string;
  vatIncluded: boolean;
  observedAt: string;
}

export interface VariantOffer {
  id: string;
  url: string;
  condition: "new" | "refurbished";
  retailer: { id: string; name: string; baseUrl: string };
  currentPrice: VariantPrice | null;
}

export interface VariantOfferDetail {
  variant: {
    id: string;
    name: string;
    attributes: Record<string, unknown>;
    product: {
      id: string;
      name: string;
      manufacturer: string | null;
      category: string | null;
      isDevelopmentFixture: boolean;
    };
  };
  offers: VariantOffer[];
  claims: Array<{ field: string; value: unknown; sourceUrl: string; observedAt: string; excerpt: string; mappingStatus: "accepted" | "rejected" | "unresolved" | null }>;
}

export interface AttributeReview { id: string; rawName: string; value: unknown; sourceUrl: string; variantId: string; }

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getVariantOfferDetail(
  db: Knex,
  principal: Principal,
  variantId: string,
): Promise<Result<VariantOfferDetail>> {
  if (!isAuthorized(principal, "catalogue.read")) {
    return err({ kind: "forbidden", capability: "catalogue.read" });
  }
  if (!UUID_PATTERN.test(variantId)) {
    return err({
      kind: "invalid-input",
      field: "variantId",
      message: "variantId must be a UUID",
    });
  }

  const variantRow = await db("variants")
    .join("products", "products.id", "variants.product_id")
    .select(
      "variants.id",
      "variants.name",
      "variants.attributes",
      "products.id as product_id",
      "products.name as product_name",
      "products.manufacturer as product_manufacturer",
      "products.category as product_category",
      "products.is_development_fixture as product_is_development_fixture",
    )
    .where("variants.id", variantId)
    .first();

  if (!variantRow) {
    return err({ kind: "not-found", resource: "variant", id: variantId });
  }

  const offerRows = await db("offers")
    .join("retailers", "retailers.id", "offers.retailer_id")
    .leftJoin(
      db("price_observations")
        .distinctOn("offer_id")
        .select(
          "offer_id",
          "amount",
          "currency",
          "shipping_amount",
          "vat_included",
          "observed_at",
        )
        .orderBy([
          { column: "offer_id" },
          { column: "observed_at", order: "desc" },
        ])
        .as("latest_observation"),
      "latest_observation.offer_id",
      "offers.id",
    )
    .select(
      "offers.id",
      "offers.url",
      "offers.condition",
      "retailers.id as retailer_id",
      "retailers.name as retailer_name",
      "retailers.base_url as retailer_base_url",
      "latest_observation.amount as price_amount",
      "latest_observation.currency as price_currency",
      "latest_observation.shipping_amount as price_shipping_amount",
      "latest_observation.vat_included as price_vat_included",
      "latest_observation.observed_at as price_observed_at",
    )
    .where("offers.variant_id", variantId)
    .orderBy("retailers.name");

  const claims = await db("source_claims")
    .join("source_evidence", "source_evidence.id", "source_claims.evidence_id")
    .where((query) => query
      .where("source_claims.product_id", variantRow.product_id)
      .orWhere("source_claims.variant_id", variantId)
      .orWhereIn("source_claims.offer_id", offerRows.map((offer) => offer.id)))
    .select("source_claims.field", "source_claims.value", "source_claims.mapping_status", "source_claims.observed_at", "source_evidence.source_url", "source_evidence.excerpt")
    .orderBy("source_claims.observed_at", "desc");

  return ok({
    variant: {
      id: variantRow.id,
      name: variantRow.name,
      attributes: variantRow.attributes ?? {},
      product: {
        id: variantRow.product_id,
        name: variantRow.product_name,
        manufacturer: variantRow.product_manufacturer,
        category: variantRow.product_category,
        isDevelopmentFixture: variantRow.product_is_development_fixture,
      },
    },
    offers: offerRows.map((row) => ({
      id: row.id,
      url: row.url,
      condition: row.condition,
      retailer: {
        id: row.retailer_id,
        name: row.retailer_name,
        baseUrl: row.retailer_base_url,
      },
      currentPrice:
        row.price_amount == null
          ? null
          : {
              amount: String(row.price_amount),
              currency: row.price_currency,
              shippingAmount: String(row.price_shipping_amount),
              deliveredAmount: addMoney(
                String(row.price_amount),
                String(row.price_shipping_amount),
              ),
              vatIncluded: row.price_vat_included,
              observedAt: new Date(row.price_observed_at).toISOString(),
            },
    })),
    claims: claims.map((claim) => ({
      field: claim.field,
      value: claim.value,
      sourceUrl: claim.source_url,
      excerpt: claim.excerpt,
      mappingStatus: claim.mapping_status,
      observedAt: new Date(claim.observed_at).toISOString(),
    })),
  });
}

export async function listAttributeReviews(db: Knex, principal: Principal): Promise<Result<AttributeReview[]>> {
  if (!isAuthorized(principal, "installation.manage")) return err({ kind: "forbidden", capability: "installation.manage" });
  const claims = await db("source_claims").join("source_evidence", "source_evidence.id", "source_claims.evidence_id")
    .where({ mapping_status: "unresolved" }).whereNotNull("source_claims.variant_id")
    .select("source_claims.id", "source_claims.raw_name", "source_claims.value", "source_claims.variant_id", "source_evidence.source_url")
    .orderBy("source_claims.observed_at", "desc");
  return ok(claims.map((claim) => ({ id: claim.id, rawName: claim.raw_name, value: claim.value, variantId: claim.variant_id, sourceUrl: claim.source_url })));
}

export async function reviewAttributeClaim(db: Knex, principal: Principal, claimId: string, canonicalKey: string | null): Promise<Result<void>> {
  if (!isAuthorized(principal, "installation.manage")) return err({ kind: "forbidden", capability: "installation.manage" });
  if (!UUID_PATTERN.test(claimId)) return err({ kind: "invalid-input", field: "claimId", message: "claimId must be a UUID" });
  const claim = await db("source_claims").where({ id: claimId, mapping_status: "unresolved" }).first();
  if (!claim) return err({ kind: "not-found", resource: "attribute claim", id: claimId });
  if (canonicalKey === null) { await db("source_claims").where({ id: claimId }).update({ mapping_status: "rejected" }); return ok(undefined); }
  const attribute = await db("catalogue_attributes").where({ key: canonicalKey }).first();
  if (!attribute) return err({ kind: "invalid-input", field: "canonicalKey", message: "Unknown canonical attribute" });
  await db.transaction(async (trx) => {
    await trx("source_claims").where({ id: claimId }).update({ mapping_status: "accepted", canonical_attribute_id: attribute.id });
    const variant = await trx("variants").where({ id: claim.variant_id }).first();
    await trx("variants").where({ id: claim.variant_id }).update({ attributes: { ...(variant.attributes ?? {}), [canonicalKey]: claim.value } });
    await trx("attribute_assessments").where({ variant_id: claim.variant_id, attribute_id: attribute.id }).whereNull("invalidated_at").update({ invalidated_at: trx.fn.now() });
  });
  return ok(undefined);
}
