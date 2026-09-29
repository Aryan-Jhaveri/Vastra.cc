ALTER TABLE `users` ADD `accepted_terms_at` integer;--> statement-breakpoint
-- Backfill: existing (pre-launch) users are treated as having implicitly
-- accepted the Terms at the time this migration runs. New signups set this
-- explicitly via the required consent checkbox.
UPDATE `users` SET `accepted_terms_at` = 1783700000000 WHERE `accepted_terms_at` IS NULL;
