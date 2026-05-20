// Contains all database access functions used by the application.
import { eq, sql } from "drizzle-orm";

import { db } from "~/db/client";
import { chats, kv, type ChatType } from "~/db/schema";

export type UpsertChatInput = {
  id: number;
  type: ChatType;
  title: string | null;
  addedByUserId: number | null;
};

const nowMs = sql`(unixepoch() * 1000)`;

export const getKvValue = async (key: string): Promise<string | null> => {
  const [row] = await db.select({ value: kv.value }).from(kv).where(eq(kv.key, key));

  return row?.value ?? null;
};

export const upsertChat = async (input: UpsertChatInput): Promise<void> => {
  await db
    .insert(chats)
    .values({
      id: input.id,
      type: input.type,
      title: input.title,
      addedByUserId: input.addedByUserId,
      active: true,
      banned: false,
      deactivatedAt: null
    })
    .onConflictDoUpdate({
      target: chats.id,
      set: {
        type: input.type,
        title: input.title,
        active: true,
        deactivatedAt: null
      }
    });
};

export const setChatActive = async (
  chatId: number,
  active: boolean
): Promise<void> => {
  await db
    .update(chats)
    .set({
      active,
      deactivatedAt: active ? null : nowMs
    })
    .where(eq(chats.id, chatId));
};
