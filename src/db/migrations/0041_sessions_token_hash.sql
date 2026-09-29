-- #360: sessions store a SHA-256 hash of the random session token, never the
-- token itself, so a database or backup read can't be replayed as live
-- sessions. The raw tokens can't be kept, so the table is recreated and every
-- existing session ends (everyone signs in once more).
DROP INDEX IF EXISTS `sessions_token_unique`;--> statement-breakpoint
DROP TABLE IF EXISTS `sessions`;--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);
