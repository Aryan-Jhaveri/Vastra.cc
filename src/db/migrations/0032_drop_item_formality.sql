-- #280: formality enrichment removed. 0031 already ran on prod (#309 deploy),
-- so the column is dropped here rather than by deleting 0031. Jev now infers
-- formality from the full item text (src/ai/decisionText.ts).
ALTER TABLE `items` DROP COLUMN `formality`;
