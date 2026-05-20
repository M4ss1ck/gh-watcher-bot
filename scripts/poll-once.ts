// Polls one GitHub account and prints a debug summary.
import {
  countEventsForAccount,
  getGitHubAccountByLogin,
  upsertGitHubAccount
} from "~/db/queries";
import { createGitHubClient } from "~/github/client";
import { pollGitHubAccount } from "~/github/poller";
import { logger } from "~/lib/logger";

const normalizeLogin = (value: string): string => value.trim().replace(/^@/, "");

const rawLogin = Bun.argv[2];

if (rawLogin === undefined || rawLogin.trim().length === 0) {
  logger.error("usage: bun run scripts/poll-once.ts <github-login>");
  process.exit(1);
}

const client = createGitHubClient();
const requestedLogin = normalizeLogin(rawLogin);
const user = await client.getUser(requestedLogin);

await upsertGitHubAccount({
  id: user.id,
  login: user.login
});

const account = await getGitHubAccountByLogin(user.login);

if (account === null) {
  logger.error({ account_login: user.login }, "account row was not created");
  process.exit(1);
}

const beforeCount = await countEventsForAccount(account.id);
const result = await pollGitHubAccount(account, { client });
const afterCount = await countEventsForAccount(account.id);

logger.info(
  {
    account_id: account.id,
    account_login: user.login,
    status: result.status,
    fetched_count: result.fetchedCount,
    inserted_count: result.insertedCount,
    events_before: beforeCount,
    events_after: afterCount
  },
  "poll complete"
);
