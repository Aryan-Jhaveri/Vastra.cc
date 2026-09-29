ALTER TABLE `users` ADD `openrouter_key_hash` text;--> statement-breakpoint
ALTER TABLE `users` ADD `openrouter_key_encrypted` text;--> statement-breakpoint
ALTER TABLE `users` ADD `openrouter_limit_usd` real;--> statement-breakpoint
ALTER TABLE `users` ADD `openrouter_key_created_at` integer;
