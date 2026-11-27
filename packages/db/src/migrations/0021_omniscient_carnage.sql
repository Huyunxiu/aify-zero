ALTER TABLE `session` ADD `subagent_name` text;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_session_parent_subagent_name` ON `session` (`parent_session_id`,`subagent_name`);