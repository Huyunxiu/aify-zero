DROP INDEX "idx_sessionid";--> statement-breakpoint
ALTER TABLE `ai_model` ALTER COLUMN "supports" TO "supports" text;--> statement-breakpoint
CREATE INDEX `idx_sessionid` ON `message` (`session_id`);--> statement-breakpoint
ALTER TABLE `ai_model` ADD `api_url` text NOT NULL;--> statement-breakpoint
ALTER TABLE `ai_model` ADD `api_key` text NOT NULL;