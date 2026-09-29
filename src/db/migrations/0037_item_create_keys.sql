-- #347 / #349: idempotency keys for POST /api/items. A retry after a lost
-- response replays the item the first attempt created instead of saving a
-- duplicate. A row is a lease while item_id is NULL (an attempt is in flight;
-- a crashed attempt's lease expires and can be taken over) and a replay record
-- once item_id is set. Deleting the item or the user deletes the key.
--
-- Hand-written, not `drizzle-kit generate` (meta/ snapshots stop at 0029).
CREATE TABLE IF NOT EXISTS `item_create_keys` (
	`user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`key` text NOT NULL,
	`item_id` text REFERENCES `items`(`id`) ON DELETE CASCADE,
	`token` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY (`user_id`, `key`)
);
