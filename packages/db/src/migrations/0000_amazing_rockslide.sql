CREATE TABLE `message` (
	`id` text(36) PRIMARY KEY NOT NULL,
	`thread_id` text,
	`role` text NOT NULL,
	`metadata` text,
	`content` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_threadid` ON `message` (`thread_id`);--> statement-breakpoint
CREATE TABLE `thread` (
	`id` text(36) PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`metadata` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
