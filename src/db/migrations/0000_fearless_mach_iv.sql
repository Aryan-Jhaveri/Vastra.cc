CREATE TABLE `items` (
	`id` text PRIMARY KEY NOT NULL,
	`image_uri` text NOT NULL,
	`tag_image_uri` text,
	`category` text NOT NULL,
	`subcategory` text,
	`primary_color` text,
	`colors` text DEFAULT '[]',
	`material` text,
	`care_instructions` text DEFAULT '[]',
	`brand` text,
	`size` text,
	`season` text DEFAULT '[]',
	`tags` text DEFAULT '[]',
	`ai_description` text,
	`occasion` text DEFAULT '[]',
	`times_worn` integer DEFAULT 0,
	`last_worn_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `outfits` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`item_ids` text NOT NULL,
	`occasion` text,
	`season` text DEFAULT '[]',
	`ai_generated` integer DEFAULT 0,
	`weather_context` text,
	`notes` text,
	`times_worn` integer DEFAULT 0,
	`last_worn_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tryon_results` (
	`id` text PRIMARY KEY NOT NULL,
	`user_photo_id` text NOT NULL,
	`outfit_id` text,
	`item_ids` text NOT NULL,
	`result_image_uri` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user_photos` (
	`id` text PRIMARY KEY NOT NULL,
	`image_uri` text NOT NULL,
	`label` text,
	`is_primary` integer DEFAULT 0,
	`created_at` integer NOT NULL
);
