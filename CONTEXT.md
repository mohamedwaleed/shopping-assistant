# Shopping assistance

Shopping research, product comparison, and offer monitoring for shoppers in the Netherlands.

## Language

**Workspace**:
The ownership boundary for a shopper’s conversations, provider credentials, watchlists, and notification settings. Initially a workspace contains one user.
_Avoid_: Account, tenant

**Shopper**:
A person using the assistant to research and compare products and find retailer offers.

**Recommendation**:
A suggested product accompanied by an explanation of how it meets the shopper’s requirements.

**Affiliate link**:
A disclosed retailer link that can generate revenue for the service. Affiliate revenue does not influence recommendation ranking.

**Product**:
A model offered by a manufacturer, potentially available in multiple configurations.

**Variant**:
An exact product configuration distinguished by attributes such as size, colour, memory, or storage. Comparisons and monitoring use exact variants when identity is established; uncertain matches are labelled.

**Offer**:
A business retailer’s listing for a variant, including price, availability, condition, and delivery information.
_Avoid_: Product, price

**Price observation**:
An offer’s recorded price at a particular time.

**Price watch**:
A shopper’s request to monitor an exact offer or variant for a target price or price drop.
_Avoid_: Broad requirement monitoring

**Public catalogue**:
Product facts and offers with source provenance that may be reused across workspaces in the hosted service. Each self-hosted installation maintains its own catalogue.

**Must-have requirement**:
A shopper constraint that must be verified before a candidate qualifies as fully recommended. It cannot be silently relaxed.

**Preference**:
A shopper criterion used to rank suitable candidates without excluding candidates solely for failing it.

**Delivered total**:
The EUR price including VAT and known mandatory delivery charges. Unknown delivery costs and conditional discounts are disclosed separately.

**Target-price alert**:
A notification triggered when a watched price crosses the shopper’s target threshold, based on a fresh successful observation.

**Price-drop alert**:
A notification triggered by a sufficient decrease relative to the last notified price, based on a fresh successful observation.

**Source claim**:
A statement about a product, variant, or offer attributed to a source and observation time. Conflicting claims remain visible rather than automatically becoming verified attributes.

**Shopping session**:
A conversation and its buying requirements, research, and comparisons for a shopping task. Requirements remain session-specific unless explicitly saved as preferences.

**Saved preference**:
A shopper-approved preference reusable across sessions, with visible application and controls to edit or delete it.

**Advertised discount**:
A retailer’s claim of a reduction, distinguished from a reduction supported by the catalogue’s observed price history.
