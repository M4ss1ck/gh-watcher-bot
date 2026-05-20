// Contains all database access functions used by the application.
import { eq } from "drizzle-orm";

import { db } from "~/db/client";
import { kv } from "~/db/schema";

export const getKvValue = async (key: string): Promise<string | null> => {
  const [row] = await db.select({ value: kv.value }).from(kv).where(eq(kv.key, key));

  return row?.value ?? null;
};
