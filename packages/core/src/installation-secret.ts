// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * One installation secret protects every stored credential: the SMTP password
 * and provider API keys. It is held by the operator outside PostgreSQL, so a
 * database dump alone reveals nothing (docs/adr/0012, docs/adr/0014).
 */
export const INSTALLATION_SECRET_ENV = "INSTALLATION_SECRET";

/** Short secrets derive weak keys, so both consumers reject them. */
export const MINIMUM_INSTALLATION_SECRET_LENGTH = 16;
