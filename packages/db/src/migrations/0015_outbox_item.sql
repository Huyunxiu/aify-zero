CREATE TABLE `outbox_item` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`delivered_at` integer,
	`expired_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_outbox_session_turn` ON `outbox_item` (`session_id`,`turn_id`);--> statement-breakpoint
CREATE INDEX `idx_outbox_pending` ON `outbox_item` (`delivered_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_outbox_created` ON `outbox_item` (`created_at`);