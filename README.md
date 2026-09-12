# gh-watcher-bot

Telegram bot that watches public GitHub accounts and delivers activity digests on a schedule. Multi-tenant: any chat can subscribe to any public GitHub user, pick which events matter, and get a digest as events happen, hourly, every 6 hours, daily, or weekly.

## Features

- Watch any public GitHub account (user firehose or selected repositories)
- Digest delivery on per-subscription schedules with timezone support
- Event filter presets (releases only, PRs and releases, code activity, new stuff, firehose) plus fully custom filters
- Optional AI-written prose summaries per subscription, using the cheapest working opencode Go model, with automatic fallback to the standard digest
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
   | GITHUB_TOKEN | no | Raises GitHub rate limits from 60/hour to 5000/hour (public data only) |
   | OPENCODE_API_KEY | no | Enables the per-subscription AI summary toggle |
   | LOG_LEVEL, NODE_ENV, POLL_INTERVAL_CRON, MAX_SUBS_PER_CHAT, REPO_POLL_THRESHOLD | no | See .env.example defaults |

   Without a token, GitHub allows 60 requests/hour per IP. With one, 5000/hour. A classic PAT with no scopes selected is enough: the bot reads only public data, and an unscoped token still gets the full authenticated limit. Conditional requests that come back 304 still count against the quota, so ETag caching saves bandwidth, not rate limit. The cost scales: when a subscription selects at or under REPO_POLL_THRESHOLD repos, the collector polls each repo separately every tick (src/scheduler/collector.ts:155-167), so one subscription watching 5 repos costs 5 requests per tick instead of 1.

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

The model is not hardcoded. At boot and then daily, the bot joins opencode Go's live model list with the prices published on models.dev, ranks models by the estimated cost of one digest, and sends a real summary request to the cheapest few (three at a time, at most six). The cheapest one that finishes with text wins. Models served on the OpenAI Responses or Anthropic Messages endpoints get the matching request shape, with reasoning set to the lowest effort they accept.

- If a cheaper model failed its probe, or a digest request shows the chosen model truncating or rejecting requests, the bot uses the next one and checks again within the hour.
- If models.dev or the model list is unreachable, the bot uses deepseek-v4-flash and retries within the hour.
- /admin diagnostics shows the current pick, why it was chosen, and its estimated cost per digest.

## Development

    bun test                       # test suite
    bun run typecheck              # tsc --noEmit
    bun run db:generate            # drizzle-kit generate
    bun run poll:once <username>   # poll one GitHub account and print a summary
    bun run ai:check               # live: pick the summary model, write one digest, check it (paid, needs OPENCODE_API_KEY)

Architecture, constraints, and conventions live in AGENTS.md.
