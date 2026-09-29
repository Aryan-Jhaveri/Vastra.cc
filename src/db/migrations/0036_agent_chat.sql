-- #318: agent loop history. chat_threads + chat_messages + agent_pending_actions
-- (durable write-tool confirmations) + chat_turn_leases (one turn in flight per
-- user). Every table is user-scoped with ON DELETE CASCADE.
--
-- Hand-written, not `drizzle-kit generate`: meta/ snapshots stop at 0029, so a
-- generated diff would re-emit 0030–0035. IF NOT EXISTS keeps re-runs harmless.
CREATE TABLE IF NOT EXISTS `chat_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`title` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `chat_threads_user_idx` ON `chat_threads` (`user_id`, `updated_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `chat_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL REFERENCES `chat_threads`(`id`) ON DELETE CASCADE,
	`user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`turn_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`tool_calls` text,
	`provider_state` text,
	`tool_call_id` text,
	`tool_name` text,
	`seq` integer NOT NULL,
	`created_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `chat_messages_thread_idx` ON `chat_messages` (`user_id`, `thread_id`, `seq`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `agent_pending_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`thread_id` text NOT NULL REFERENCES `chat_threads`(`id`) ON DELETE CASCADE,
	`assistant_message_id` text NOT NULL REFERENCES `chat_messages`(`id`) ON DELETE CASCADE,
	`tool_call_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`args` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_pending_actions_thread_idx` ON `agent_pending_actions` (`user_id`, `thread_id`, `status`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `chat_turn_leases` (
	`user_id` text PRIMARY KEY NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`token` text NOT NULL,
	`expires_at` integer NOT NULL
);
