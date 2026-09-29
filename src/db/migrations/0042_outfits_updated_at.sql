-- #376: outfits get a change marker like items.updated_at. The embeddings
-- reconciler re-embeds an outfit whose text vector is older than it, which is
-- how bulk edits such as deleting a tag everywhere reach the vectors.
--
-- Backfill: every existing outfit is stamped with the migration time, so the
-- reconciler checks each one once. An outfit whose stored source text still
-- matches is only re-stamped (no model call); one changed by an earlier
-- delete-everywhere (#372) is re-embedded.
--
-- Hand-written, not `drizzle-kit generate` (meta/ snapshots stop at 0029).
ALTER TABLE `outfits` ADD `updated_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `outfits` SET `updated_at` = CAST(strftime('%s', 'now') AS INTEGER) * 1000;
