CREATE TABLE IF NOT EXISTS `ai_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`item_id` text,
	`outfit_id` text,
	`task` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`tokens_in` integer DEFAULT 0 NOT NULL,
	`tokens_out` integer DEFAULT 0 NOT NULL,
	`wholesale_cost_cents_x100` integer DEFAULT 0 NOT NULL,
	`billed_tokens` integer DEFAULT 0 NOT NULL,
	`latency_ms` integer,
	`success` integer DEFAULT 1 NOT NULL,
	`parse_success` integer DEFAULT 1 NOT NULL,
	`error_message` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`outfit_id`) REFERENCES `outfits`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ai_calls_user_idx` ON `ai_calls` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ai_calls_task_idx` ON `ai_calls` (`task`,`created_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `user_wallets` (
	`user_id` text PRIMARY KEY NOT NULL,
	`balance_tokens` integer DEFAULT 0 NOT NULL,
	`lifetime_purchased` integer DEFAULT 0 NOT NULL,
	`lifetime_spent_tokens` integer DEFAULT 0 NOT NULL,
	`subscription_tier` text,
	`subscription_status` text,
	`monthly_grant_tokens` integer DEFAULT 0 NOT NULL,
	`next_grant_at` integer,
	`stripe_customer_id` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `user_wallets_stripe_customer_id_unique` ON `user_wallets` (`stripe_customer_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `wallet_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`delta_tokens` integer NOT NULL,
	`reason` text NOT NULL,
	`ai_call_id` text,
	`stripe_event_id` text,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `wallet_ledger_stripe_event_id_unique` ON `wallet_ledger` (`stripe_event_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ledger_user_idx` ON `wallet_ledger` (`user_id`,`created_at`);