// SPDX-License-Identifier: AGPL-3.0-or-later
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@shopping/core", "@shopping/db"],
  // Knex dynamically requires per-dialect drivers; keep it and pg out of the
  // server bundle so only the real pg dependency is resolved at runtime.
  serverExternalPackages: ["knex", "pg"],
};

export default nextConfig;
