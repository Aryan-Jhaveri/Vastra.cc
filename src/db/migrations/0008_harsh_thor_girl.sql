CREATE TABLE `share_payloads` (
	`id` text PRIMARY KEY NOT NULL,
	`created_by_user_id` text DEFAULT 'self' NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`source` text NOT NULL,
	`source_ref` text,
	`description` text NOT NULL,
	`image_uris` text DEFAULT '[]' NOT NULL,
	`sender_handle` text,
	`visibility` text DEFAULT 'link' NOT NULL,
	`recipient_user_id` text,
	`opened_at` integer,
	`open_count` integer DEFAULT 0 NOT NULL
);
