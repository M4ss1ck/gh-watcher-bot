// Configures the root pino logger and child logger helper.
import pino from "pino";

import { env } from "~/lib/env";

export const logger = pino({
  level: env.LOG_LEVEL,
  transport:
    env.NODE_ENV === "production"
      ? undefined
      : {
          target: "pino-pretty",
          options: {
            colorize: true,
            ignore: "pid,hostname",
            translateTime: "SYS:standard"
          }
        }
});

export const createChildLogger = (bindings: pino.Bindings) => logger.child(bindings);
