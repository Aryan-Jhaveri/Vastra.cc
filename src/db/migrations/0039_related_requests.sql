-- #332 / #279: every "Find related" tap is logged per user (even though it's
-- free) and counted toward a rolling 24 h cap. status: pending → success |
-- empty | error; capped attempts are logged too. counts_toward_cap is 1 for
-- pending/success/empty (a pending row holds its slot, so parallel taps can't
-- exceed the cap) and 0 for error/capped. result keeps ids + scores only.
CREATE TABLE IF NOT EXISTS `related_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`kind` text NOT NULL,
	`target_id` text NOT NULL,
	`status` text NOT NULL,
	`counts_toward_cap` integer NOT NULL,
	`candidate_count` integer,
	`result` text,
	`fingerprint` text,
	`batch_count` integer,
	`latency_ms` integer,
	`cost_x100` integer,
	`created_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_related_requests_user_time` ON `related_requests` (`user_id`, `created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_related_requests_target` ON `related_requests` (`user_id`, `kind`, `target_id`, `created_at`);
