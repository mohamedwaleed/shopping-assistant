// Knex CLI entry point. Kept in CommonJS so `knex migrate:*` runs without a
// TypeScript loader; application code uses src/knexfile.ts instead.
const path = require("node:path");

const connection =
  process.env.DATABASE_URL ??
  "postgres://postgres:postgres@localhost:54329/shopping_assistant_dev";

module.exports = {
  client: "pg",
  connection,
  migrations: {
    directory: path.join(__dirname, "src", "migrations"),
  },
};
