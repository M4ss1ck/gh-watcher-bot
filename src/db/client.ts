// Creates the libSQL client and Drizzle database connection.
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";

import * as schema from "~/db/schema";
import { env } from "~/lib/env";

export const libsqlClient = createClient({
  url: env.DATABASE_URL,
  authToken: env.DATABASE_AUTH_TOKEN || undefined
});

export const db = drizzle(libsqlClient, { schema });
