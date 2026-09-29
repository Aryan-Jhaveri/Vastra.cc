-- No-op. Original ALTERs moved to 0020_fix_skipped_occasion.sql because
-- drizzle's MAX(folderMillis) skip logic permanently bypassed this migration
-- on installs where 0018/0019 ran first. 0020 has a higher `when` so it
-- runs on broken installs; fresh installs run both — 0017 now no-op, 0020 adds.
SELECT 1;
