CREATE TABLE `embeddings` (
	`id` text PRIMARY KEY NOT NULL,
	`level` text NOT NULL,
	`ref_id` text NOT NULL,
	`user_id` text DEFAULT 'self' NOT NULL,
	`variant` text DEFAULT 'main' NOT NULL,
	`model_version` text NOT NULL,
	`vector` blob NOT NULL,
	`source_blob` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_embeddings_unique` ON `embeddings` (`level`, `ref_id`, `variant`, `model_version`);
--> statement-breakpoint
CREATE INDEX `idx_embeddings_level_ref` ON `embeddings` (`level`, `ref_id`);
--> statement-breakpoint
CREATE INDEX `idx_embeddings_user_level` ON `embeddings` (`user_id`, `level`, `model_version`);
--> statement-breakpoint
CREATE TABLE `query_embeddings` (
	`query_hash` text PRIMARY KEY NOT NULL,
	`query_text` text NOT NULL,
	`model_version` text NOT NULL,
	`vector` blob NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer NOT NULL
);
