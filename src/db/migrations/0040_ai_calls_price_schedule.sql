-- #344: which versioned price schedule (src/cost/tokenTable.ts PRICE_SCHEDULES)
-- produced each ai_calls cost estimate, or 'provider-reported' when the
-- provider billed the amount. Existing rows stay NULL: their rates weren't
-- recorded, and they are never re-priced implicitly.
ALTER TABLE `ai_calls` ADD `price_schedule_id` text;
