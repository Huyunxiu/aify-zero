ALTER TABLE `session` ADD `kind` text DEFAULT 'main' NOT NULL;--> statement-breakpoint
ALTER TABLE `session` ADD `parent_session_id` text;--> statement-breakpoint
ALTER TABLE `session` ADD `parent_tool_call_id` text;--> statement-breakpoint
CREATE INDEX `idx_session_kind_created` ON `session` (`kind`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_session_parent_tool_call` ON `session` (`parent_session_id`,`parent_tool_call_id`);