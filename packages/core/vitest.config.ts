// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30000,
    hookTimeout: 60000,
    // Test files share one PostgreSQL database, and each file resets the
    // schema; running them one at a time keeps Knex migrations unlocked.
    fileParallelism: false,
  },
});
