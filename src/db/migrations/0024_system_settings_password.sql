-- Move the admin fallback password from the legacy per-user 'self' row to a
-- reserved '__system__' user_id, so multi-user POST /api/settings/password
-- writes can never overwrite the admin password (issue #68).
-- Idempotent: only acts when the legacy 'self' row exists AND no '__system__'
-- row has been created yet — re-running is a no-op.
UPDATE `settings` SET `user_id` = '__system__'
WHERE `key` = 'password'
  AND `user_id` = 'self'
  AND NOT EXISTS (
    SELECT 1 FROM `settings` `s2`
    WHERE `s2`.`key` = 'password' AND `s2`.`user_id` = '__system__'
  );
