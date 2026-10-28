CREATE TABLE `step` (
	`id` text PRIMARY KEY NOT NULL,
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
CREATE UNIQUE INDEX `idx_step_turn_seq` ON `step` (`turn_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_step_session_created` ON `step` (`session_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `turn` ADD `status` text DEFAULT 'done' NOT NULL;--> statement-breakpoint
ALTER TABLE `turn` ADD `detail` text;--> statement-breakpoint
ALTER TABLE `turn` ADD `completed_at` integer;--> statement-breakpoint
-- 把旧 turn.content 里的 step 数组拆成 step 行。必须在 0006 删除 content 之前执行。
INSERT INTO `step` (`id`,`turn_id`,`session_id`,`seq`,`stream_id`,`type`,`status`,`content`,`created_at`,`updated_at`)
SELECT
	json_extract(`step`.`value`, '$.id'),
	`turn`.`id`,
	`turn`.`session_id`,
	CAST(`step`.`key` AS INTEGER),
	NULL,
	json_extract(`step`.`value`, '$.type'),
	COALESCE(json_extract(`step`.`value`, '$.status'), 'done'),
	`step`.`value`,
	CAST(COALESCE(json_extract(`step`.`value`, '$.createdAt'), json_extract(`turn`.`content`, '$.createdAt')) AS INTEGER),
	CAST(unixepoch() * 1000 AS INTEGER)
FROM `turn`, json_each(`turn`.`content`, '$.content') AS `step`;--> statement-breakpoint
-- 把 turn 级字段从旧 content 提到列上。
UPDATE `turn` SET
	`status` = COALESCE(json_extract(`content`, '$.status'), 'done'),
	`detail` = json_object(
		'usage', json_extract(`content`, '$.usage'),
		'performance', json_extract(`content`, '$.performance'),
		'finishReason', json_extract(`content`, '$.finishReason'),
		'rawFinishReason', json_extract(`content`, '$.rawFinishReason'),
		'providerMetadata', json_extract(`content`, '$.providerMetadata'),
		'error', json_extract(`content`, '$.error'),
		'abortReason', json_extract(`content`, '$.abortReason')
	),
	`completed_at` = CAST(json_extract(`content`, '$.completedAt') AS INTEGER);