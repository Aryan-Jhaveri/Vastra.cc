CREATE TABLE `login_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `login_tokens_token_unique` ON `login_tokens` (`token`);--> statement-breakpoint
CREATE TABLE `oauth_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_unique` ON `sessions` (`token`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
ALTER TABLE `collections` ADD `user_id` text DEFAULT 'self' NOT NULL;--> statement-breakpoint
ALTER TABLE `item_images` ADD `user_id` text DEFAULT 'self' NOT NULL;--> statement-breakpoint
ALTER TABLE `items` ADD `user_id` text DEFAULT 'self' NOT NULL;--> statement-breakpoint
ALTER TABLE `job_runs` ADD `user_id` text DEFAULT 'self' NOT NULL;--> statement-breakpoint
ALTER TABLE `outfits` ADD `user_id` text DEFAULT 'self' NOT NULL;--> statement-breakpoint
ALTER TABLE `push_subscriptions` ADD `user_id` text DEFAULT 'self' NOT NULL;--> statement-breakpoint
ALTER TABLE `scheduled_jobs` ADD `user_id` text DEFAULT 'self' NOT NULL;--> statement-breakpoint
ALTER TABLE `share_payloads` ADD `user_id` text DEFAULT 'self' NOT NULL;--> statement-breakpoint
ALTER TABLE `tryon_results` ADD `user_id` text DEFAULT 'self' NOT NULL;--> statement-breakpoint
ALTER TABLE `user_photos` ADD `user_id` text DEFAULT 'self' NOT NULL;