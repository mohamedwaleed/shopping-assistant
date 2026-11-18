// SPDX-License-Identifier: AGPL-3.0-or-later
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@shopping/core", "@shopping/db"],
  // Allow local development through 127.0.0.1 so Server Actions pass Next's
  // origin/host check. That check also runs in production, so local origins
  // must be listed here and not only in `allowedDevOrigins`.
  allowedDevOrigins: ["127.0.0.1"],
  experimental: {
    serverActions: { allowedOrigins: ["127.0.0.1", "localhost:3000"] },
  },
  // Knex dynamically requires per-dialect drivers; keep it and pg out of the
  // server bundle so only the real pg dependency is resolved at runtime.
  serverExternalPackages: ["knex", "pg"],
};

export default nextConfig;
