CREATE TABLE `inbox_message` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`session_id` text NOT NULL,
	`request_id` text NOT NULL,
	`placement` text NOT NULL,
	`content` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inbox_message_id_unique` ON `inbox_message` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_inbox_session_request` ON `inbox_message` (`session_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `idx_inbox_session_placement_seq` ON `inbox_message` (`session_id`,`placement`,`seq`);