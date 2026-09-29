ALTER TABLE `wallet_ledger` ADD `idempotency_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `wallet_ledger_idempotency_key_idx` ON `wallet_ledger` (`idempotency_key`);
