# gh-watcher-bot

Telegram bot that watches public GitHub accounts and delivers activity digests on a schedule. Multi-tenant: any chat can subscribe to any public GitHub user, pick which events matter, and get a digest as events happen, hourly, every 6 hours, daily, or weekly.

## Features

- Watch any public GitHub account (user firehose or selected repositories)
- Digest delivery on per-subscription schedules with timezone support
- Event filter presets (releases only, PRs and releases, code activity, new stuff, firehose) plus fully custom filters
- Optional AI-written prose summaries (opencode Go, deepseek-v4-flash) per subscription, with automatic fallback to the standard digest
- Merged pull request enrichment (diff stats, description)
- Runs as a single process: long-polls Telegram, polls GitHub REST with ETags, no inbound HTTP

## Requirements

- A Telegram bot token from @BotFather
- Bun (local runs) or Docker (recommended)
- Optional: a GitHub token for higher API rate limits
- Optional: an opencode Zen API key for AI summaries

## Setup

1. Copy the env template and fill it in:

   cp .env.example .env

   | Variable | Required | Purpose |
   | --- | --- | --- |
   | BOT_TOKEN | yes | Telegram bot token |
   | ADMIN_IDS | yes | Comma-separated Telegram user IDs with admin access |
   | DATABASE_URL | yes | file:./data/dev.db locally, libsql://... for Turso |
   | DATABASE_AUTH_TOKEN | with libsql:// | Turso auth token |
   | GITHUB_TOKEN | no | Raises GitHub rate limits (public data only) |
   | OPENCODE_API_KEY | no | Enables the per-subscription AI summary toggle |
   | LOG_LEVEL, NODE_ENV, POLL_INTERVAL_CRON, MAX_SUBS_PER_CHAT, REPO_POLL_THRESHOLD | no | See .env.example defaults |

2. Run it:

   docker compose up -d

   or locally with Bun:

   bun install
   bun run start

Migrations run automatically at startup. The Docker healthcheck reads the collector heartbeat from the database.

## Using the bot

- /start - introduce the bot
- /subscribe - list and manage this chat's subscriptions, or /subscribe <github_username> to add one
- /help - command overview
- /ping - liveness and, for admins, diagnostics
- /admin - admin menu (chats, accounts, broadcast, diagnostics, force poll/deliver); admin-only

Subscription settings (preset, filters, schedule, timezone, repos, AI summary) are edited through inline menus. Chat-scoped changes require chat admin rights.

### AI summaries

With OPENCODE_API_KEY set, each subscription menu shows an "AI summary" toggle. When on, digests arrive as a short prose summary instead of the event list. If the AI request fails, the bot sends the standard digest instead; deliveries are never blocked on the AI provider.

## Development

    bun test                       # test suite
    bun run typecheck              # tsc --noEmit
    bun run db:generate            # drizzle-kit generate
    bun run poll:once <username>   # poll one GitHub account and print a summary

Architecture, constraints, and conventions live in AGENTS.md.
