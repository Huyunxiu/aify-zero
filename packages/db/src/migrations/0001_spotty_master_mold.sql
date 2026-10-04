DROP INDEX "idx_sessionid";--> statement-breakpoint
DROP INDEX "idx_turn_parent";--> statement-breakpoint
DROP INDEX "idx_turn_session_parent";--> statement-breakpoint
ALTER TABLE `agent` ALTER COLUMN "name" TO "name" text NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_sessionid` ON `turn` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_turn_parent` ON `turn` (`parent_id`);--> statement-breakpoint
CREATE INDEX `idx_turn_session_parent` ON `turn` (`session_id`,`parent_id`);--> statement-breakpoint
ALTER TABLE `agent` ADD `avatar` text;--> statement-breakpoint
ALTER TABLE `agent` ADD `description` text;--> statement-breakpoint
ALTER TABLE `session` ADD `active_stream_id` text;