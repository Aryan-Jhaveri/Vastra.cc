-- #324: liked_products table for the "Related shop items" row + Liked items page.
-- Stores products the user has liked from Shopify Global Catalog search results.
-- saved_item_id links to the closet item created via "Save item" (SET NULL on delete).
CREATE TABLE `liked_products` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`product_id` text NOT NULL,
	`title` text NOT NULL,
	`image_url` text,
	`url` text,
	`merchant` text NOT NULL,
	`price` text,
	`available` integer DEFAULT true NOT NULL,
	`saved_item_id` text REFERENCES `items`(`id`) ON DELETE SET NULL,
	`created_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `liked_products_user_product` ON `liked_products` (`user_id`, `product_id`);--> statement-breakpoint
CREATE INDEX `liked_products_user_created` ON `liked_products` (`user_id`, `created_at`);
