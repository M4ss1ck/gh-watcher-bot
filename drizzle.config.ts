// Defines Drizzle Kit configuration for schema migrations.
import { defineConfig } from "drizzle-kit";

import { env } from "./src/lib/env";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "sqlite",
  dbCredentials: {
    url: env.DATABASE_URL
  }
});
