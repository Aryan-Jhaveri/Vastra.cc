CREATE TABLE `item_images` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`image_uri` text NOT NULL,
	`role` text,
	`view` text,
	`position` integer DEFAULT 0 NOT NULL,
	`is_primary` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
