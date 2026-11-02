PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_turn` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`turn_id` text NOT NULL,
	`session_id` text NOT NULL,
	`type` text NOT NULL,
	`metadata` text,
	`parent_id` text,
	`status` text DEFAULT 'done' NOT NULL,
	`detail` text,
	`completed_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
-- 旧的 `id` 是业务 id，搬进 `turn_id`；新的 `id` 由自增主键生成。
-- `session_id` 现在是 NOT NULL：旧库如果留下没有会话的孤儿 turn，这里会直接
-- 失败，不会静默丢数据。
INSERT INTO `__new_turn`("turn_id", "session_id", "type", "metadata", "parent_id", "status", "detail", "completed_at", "created_at", "updated_at") SELECT "id", "session_id", "type", "metadata", "parent_id", "status", "detail", "completed_at", "created_at", "updated_at" FROM `turn`;--> statement-breakpoint
DROP TABLE `turn`;--> statement-breakpoint
ALTER TABLE `__new_turn` RENAME TO `turn`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_turn_session_turn` ON `turn` (`session_id`,`turn_id`);--> statement-breakpoint
CREATE INDEX `idx_turn_session_parent` ON `turn` (`session_id`,`parent_id`);--> statement-breakpoint
CREATE TABLE `__new_step` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`step_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`session_id` text NOT NULL,
	`seq` integer NOT NULL,
	`stream_id` text,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`content` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
-- 旧的 `id` 是业务 step id，搬进 `step_id`；新的 `id` 由自增主键生成。
INSERT INTO `__new_step`("step_id", "turn_id", "session_id", "seq", "stream_id", "type", "status", "content", "created_at", "updated_at") SELECT "id", "turn_id", "session_id", "seq", "stream_id", "type", "status", "content", "created_at", "updated_at" FROM `step`;--> statement-breakpoint
DROP TABLE `step`;--> statement-breakpoint
ALTER TABLE `__new_step` RENAME TO `step`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_step_session_step` ON `step` (`session_id`,`step_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_step_turn_seq` ON `step` (`session_id`,`turn_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_step_session_created` ON `step` (`session_id`,`created_at`);