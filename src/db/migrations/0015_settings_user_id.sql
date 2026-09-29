-- Preserve existing data before recreating the settings table
CREATE TABLE `settings_temp` AS SELECT * FROM `settings`;
--> statement-breakpoint
DROP TABLE `settings`;
--> statement-breakpoint
CREATE TABLE `settings` (
  `key` text NOT NULL,
  `user_id` text NOT NULL DEFAULT 'self',
  `value` text NOT NULL,
  PRIMARY KEY (`key`, `user_id`)
);
--> statement-breakpoint
INSERT INTO `settings` (`key`, `user_id`, `value`) SELECT `key`, 'self', `value` FROM `settings_temp`;
--> statement-breakpoint
DROP TABLE `settings_temp`;
