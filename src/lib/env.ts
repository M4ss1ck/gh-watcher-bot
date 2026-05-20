// Validates environment configuration at startup.
import { z } from "zod";

const rawEnvSchema = z
  .object({
    BOT_TOKEN: z.string().min(1),
    ADMIN_IDS: z
      .string()
      .min(1)
      .transform((value, context) => {
        const ids = value.split(",").map((id) => id.trim());

        if (ids.some((id) => id.length === 0 || !/^\d+$/.test(id))) {
          context.addIssue({
            code: "custom",
            message: "ADMIN_IDS must be a comma-separated list of Telegram user IDs"
          });

          return z.NEVER;
        }

        return ids.map((id) => Number(id));
      }),
    DATABASE_URL: z.string().min(1),
    DATABASE_AUTH_TOKEN: z.string().optional(),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    POLL_INTERVAL_CRON: z.string().min(1).default("*/10 * * * *"),
    MAX_SUBS_PER_CHAT: z.coerce.number().int().positive().default(20),
    GITHUB_TOKEN: z.string().optional()
  })
  .superRefine((value, context) => {
    if (value.DATABASE_URL.startsWith("libsql://") && !value.DATABASE_AUTH_TOKEN) {
      context.addIssue({
        code: "custom",
        path: ["DATABASE_AUTH_TOKEN"],
        message: "DATABASE_AUTH_TOKEN is required when DATABASE_URL starts with libsql://"
      });
    }
  });

export const env = rawEnvSchema.parse(Bun.env);

export type Env = typeof env;
