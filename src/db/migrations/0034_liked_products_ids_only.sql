-- #324: liked_products keeps only the product id. Shopify's catalog policy
-- forbids caching results ("Caching results isn't allowed"), so the title,
-- price, availability and image snapshot are dropped and the Liked items page
-- reads live data via lookup_catalog instead.
ALTER TABLE `liked_products` DROP COLUMN `title`;--> statement-breakpoint
ALTER TABLE `liked_products` DROP COLUMN `image_url`;--> statement-breakpoint
ALTER TABLE `liked_products` DROP COLUMN `url`;--> statement-breakpoint
ALTER TABLE `liked_products` DROP COLUMN `merchant`;--> statement-breakpoint
ALTER TABLE `liked_products` DROP COLUMN `price`;--> statement-breakpoint
ALTER TABLE `liked_products` DROP COLUMN `available`;
