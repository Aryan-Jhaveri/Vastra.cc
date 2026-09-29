CREATE TABLE IF NOT EXISTS `analytics_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`session_id` text NOT NULL,
	`event_type` text NOT NULL,
	`route` text,
	`properties` text DEFAULT '{}' NOT NULL,
	`pwa_mode` integer DEFAULT 0 NOT NULL,
	`duration_ms` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `analytics_user_idx` ON `analytics_events` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `analytics_type_idx` ON `analytics_events` (`event_type`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `analytics_session_idx` ON `analytics_events` (`session_id`);