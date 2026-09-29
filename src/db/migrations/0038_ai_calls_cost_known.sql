-- #345: an ai_calls row whose provider/model has no configured price records
-- cost_known = 0 instead of a wholesale cost of 0 that reads as verified-free.
-- Existing rows default to 1 (known); pre-#345 unpriced rows can't be told apart.
ALTER TABLE `ai_calls` ADD `cost_known` integer DEFAULT 1 NOT NULL;
