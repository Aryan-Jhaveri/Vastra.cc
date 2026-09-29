CREATE TABLE `collection_outfits` (
	`collection_id` text NOT NULL,
	`outfit_id` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`added_at` integer NOT NULL,
	PRIMARY KEY(`collection_id`, `outfit_id`)
);
--> statement-breakpoint
CREATE TABLE `collections` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`cover_image_uri` text,
	`season` text DEFAULT '[]',
	`tags` text DEFAULT '[]',
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
