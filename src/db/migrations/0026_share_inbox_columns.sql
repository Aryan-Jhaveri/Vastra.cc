ALTER TABLE `share_payloads` ADD `intended_action` text;--> statement-breakpoint
ALTER TABLE `share_payloads` ADD `claim_token` text;--> statement-breakpoint
CREATE UNIQUE INDEX `share_payloads_claim_token_unique` ON `share_payloads` (`claim_token`) WHERE `claim_token` IS NOT NULL;