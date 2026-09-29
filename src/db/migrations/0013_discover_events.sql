CREATE TABLE `discover_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text DEFAULT 'self' NOT NULL,
	`mode` text NOT NULL,
	`shortlist_source` text NOT NULL,
	`item_count` integer NOT NULL,
	`shortlisted_count` integer NOT NULL,
	`suggestion_count` integer NOT NULL,
	`pre_filter_enabled` integer DEFAULT 0 NOT NULL,
	`prompt_chars` integer,
	`created_at` integer NOT NULL
);
