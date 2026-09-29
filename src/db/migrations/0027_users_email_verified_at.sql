-- Adds email_verified_at to users (#200). Backfills existing rows with
-- created_at so pre-launch accounts aren't gated on the first verify-confirm.
ALTER TABLE `users` ADD `email_verified_at` integer;--> statement-breakpoint
UPDATE `users` SET `email_verified_at` = `created_at` WHERE `email_verified_at` IS NULL;
