-- Phase 1.5 (issue #280): Jev-Choice formality enrichment. Nullable — old rows
-- stay null until the admin backfill runs.
ALTER TABLE `items` ADD `formality` integer;
