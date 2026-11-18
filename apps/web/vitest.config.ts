// SPDX-License-Identifier: AGPL-3.0-or-later
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    testTimeout: 30000,
    hookTimeout: 60000,
    environment: "node",
  },
});
