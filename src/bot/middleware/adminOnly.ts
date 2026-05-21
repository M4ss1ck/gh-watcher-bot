// Restricts bot-level admin surfaces to configured administrators.
import type { Context, MiddlewareFn } from "grammy";

import { env } from "~/lib/env";

export const isAdminUserId = (
  userId: number | undefined,
  adminIds: readonly number[] = env.ADMIN_IDS
): boolean => userId !== undefined && adminIds.includes(userId);

export const adminOnly: MiddlewareFn<Context> = async (ctx, next) => {
  if (isAdminUserId(ctx.from?.id)) {
    await next();
    return;
  }

  await ctx.reply("Admin only.");
};
