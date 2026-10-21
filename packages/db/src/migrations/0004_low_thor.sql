CREATE TABLE `project` (
	`id` text(36) PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`primary_dir` text NOT NULL,
	`additional_dirs` text DEFAULT '[]' NOT NULL,
	`config` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_project_primary_dir` ON `project` (`primary_dir`);--> statement-breakpoint
ALTER TABLE `session` ADD `project_id` text;--> statement-breakpoint
CREATE INDEX `idx_session_project_kind_created` ON `session` (`project_id`,`kind`,`created_at`);