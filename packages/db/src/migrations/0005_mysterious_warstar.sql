ALTER TABLE `message` ADD `parent_id` text;--> statement-breakpoint
CREATE INDEX `idx_message_parent` ON `message` (`parent_id`);--> statement-breakpoint
CREATE INDEX `idx_message_session_parent` ON `message` (`session_id`,`parent_id`);--> statement-breakpoint
ALTER TABLE `session` ADD `active_head_id` text;--> statement-breakpoint
ALTER TABLE `session` ADD `forked_from_session_id` text;--> statement-breakpoint
ALTER TABLE `session` ADD `forked_from_message_id` text;