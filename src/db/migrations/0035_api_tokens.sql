-- #321: Personal API tokens with scopes (read / write / ai).
-- Non-browser clients (MCP, Home Assistant, scripts) authenticate as a user
-- with a scoped bearer token. The plaintext is shown once; only the SHA-256
-- hash is stored. `prefix` (vst_ + 6 chars) is displayed in Settings so a
-- token is identifiable without the secret.
--
-- IF NOT EXISTS: journal `when` was bumped 005 → 007 to clear
-- feature/ucp-shop-row's 0033/0034 (005/006). Dev DBs that already applied
-- this at 005 re-run it harmlessly.
CREATE TABLE IF NOT EXISTS `api_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`prefix` text NOT NULL,
	`scopes` text DEFAULT '["read"]' NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`expires_at` integer,
	`revoked_at` integer
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `api_tokens_token_hash_unique` ON `api_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `api_tokens_user_idx` ON `api_tokens` (`user_id`, `created_at`);
