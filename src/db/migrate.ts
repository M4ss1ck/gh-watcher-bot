// Applies pending Drizzle migrations at startup.
import { migrate } from "drizzle-orm/libsql/migrator";

import { db } from "~/db/client";

const migrationsFolder = "./src/db/migrations";

export const runMigrations = async (): Promise<void> => {
  await migrate(db, { migrationsFolder });
};
