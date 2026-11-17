CREATE TABLE `timer` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`tool_call_id` text NOT NULL,
	`note` text NOT NULL,
	`due_at` integer NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_timer_session_tool_call` ON `timer` (`session_id`,`tool_call_id`);--> statement-breakpoint
CREATE INDEX `idx_timer_due` ON `timer` (`due_at`);--> statement-breakpoint
CREATE INDEX `idx_timer_session_due` ON `timer` (`session_id`,`due_at`);