CREATE TABLE `github_repos` (
	`id` integer PRIMARY KEY NOT NULL,
	`accountId` integer NOT NULL,
	`name` text NOT NULL,
	`etag` text,
	`lastEventId` text,
	`lastPolledAt` integer,
	`consecutiveFailures` integer DEFAULT 0 NOT NULL,
	`pausedUntil` integer,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`accountId`) REFERENCES `github_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_repos_account_id_name_unique` ON `github_repos` (`accountId`,`name`);--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `selectedRepos` text;
