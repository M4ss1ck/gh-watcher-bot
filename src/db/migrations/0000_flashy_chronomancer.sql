CREATE TABLE `chats` (
	`id` integer PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`title` text,
	`addedByUserId` integer,
	`active` integer DEFAULT true NOT NULL,
	`banned` integer DEFAULT false NOT NULL,
	`addedAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deactivatedAt` integer
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`accountId` integer NOT NULL,
	`type` text NOT NULL,
	`repoName` text NOT NULL,
	`actorLogin` text NOT NULL,
	`payload` text NOT NULL,
	`createdAt` integer NOT NULL,
	`ingestedAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`accountId`) REFERENCES `github_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `events_account_id_created_at_idx` ON `events` (`accountId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `events_type_idx` ON `events` (`type`);--> statement-breakpoint
CREATE TABLE `github_accounts` (
	`id` integer PRIMARY KEY NOT NULL,
	`login` text NOT NULL,
	`etag` text,
	`lastPolledAt` integer,
	`lastEventId` text,
	`consecutiveFailures` integer DEFAULT 0 NOT NULL,
	`pausedUntil` integer,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_accounts_login_unique` ON `github_accounts` (`login`);--> statement-breakpoint
CREATE TABLE `kv` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chatId` integer NOT NULL,
	`accountId` integer NOT NULL,
	`preset` text NOT NULL,
	`filters` text NOT NULL,
	`schedulePreset` text NOT NULL,
	`timezone` text DEFAULT 'UTC' NOT NULL,
	`lastDeliveredAt` integer,
	`paused` integer DEFAULT false NOT NULL,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`createdByUserId` integer NOT NULL,
	FOREIGN KEY (`chatId`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`accountId`) REFERENCES `github_accounts`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscriptions_chat_id_account_id_unique` ON `subscriptions` (`chatId`,`accountId`);