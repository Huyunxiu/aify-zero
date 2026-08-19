CREATE TABLE `agent` (
	`id` text(36) PRIMARY KEY NOT NULL,
	`name` text,
	`instructions` text,
	`tools` text,
	`models` text,
	`skills` text,
	`config` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
DROP TABLE `ai_model`;