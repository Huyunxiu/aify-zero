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
CREATE TABLE `dict` (
	`code` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`content` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `session` (
	`id` text(36) PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`metadata` text,
	`active_head_id` text,
	`forked_from_session_id` text,
	`forked_from_message_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `turn` (
	`id` text(36) PRIMARY KEY NOT NULL,
	`session_id` text,
	`type` text NOT NULL,
	`metadata` text,
	`content` text NOT NULL,
	`parent_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_sessionid` ON `turn` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_turn_parent` ON `turn` (`parent_id`);--> statement-breakpoint
CREATE INDEX `idx_turn_session_parent` ON `turn` (`session_id`,`parent_id`);