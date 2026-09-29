-- Durable scheduler claiming + retry cursor.
ALTER TABLE `scheduled_jobs` ADD `next_run_at` integer;--> statement-breakpoint
ALTER TABLE `scheduled_jobs` ADD `claim_token` text;--> statement-breakpoint
ALTER TABLE `scheduled_jobs` ADD `claim_expires_at` integer;--> statement-breakpoint
ALTER TABLE `scheduled_jobs` ADD `attempt_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `scheduled_jobs` ADD `retry_at` integer;--> statement-breakpoint
ALTER TABLE `scheduled_jobs` ADD `run_state` text DEFAULT 'idle' NOT NULL;--> statement-breakpoint
ALTER TABLE `scheduled_jobs` ADD `last_error` text;--> statement-breakpoint
-- Agent run/turn/step/tool-call identity for AI call instrumentation.
ALTER TABLE `ai_calls` ADD `run_id` text;--> statement-breakpoint
ALTER TABLE `ai_calls` ADD `turn_id` text;--> statement-breakpoint
ALTER TABLE `ai_calls` ADD `step_id` text;--> statement-breakpoint
ALTER TABLE `ai_calls` ADD `tool_call_id` text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ai_calls_run_idx` ON `ai_calls` (`run_id`);--> statement-breakpoint
-- Query-vector cache becomes per-user and stops storing plaintext queries.
-- The cache is derived data: dropping it only forces re-embedding.
DROP TABLE IF EXISTS `query_embeddings`;--> statement-breakpoint
CREATE TABLE `query_embeddings` (
	`query_hash` text NOT NULL,
	`user_id` text NOT NULL,
	`model_version` text NOT NULL,
	`vector` blob NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `query_hash`)
);
