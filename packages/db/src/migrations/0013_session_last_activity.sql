DROP INDEX `idx_session_kind_created`;--> statement-breakpoint
DROP INDEX `idx_session_project_kind_created`;--> statement-breakpoint
CREATE INDEX `idx_session_kind_updated` ON `session` (`kind`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_session_project_kind_updated` ON `session` (`project_id`,`kind`,`updated_at`);--> statement-breakpoint
-- 会话行的 `updated_at` 此前只取插入默认值，等于创建时刻。列表现在按最后活动
-- 排序并显示「3 分钟前」，不回填的话旧行的读数会停在建会话的那一天。
--
-- 回填按回合边界取：每个会话取它最近一次回合的完成时刻，没有完成时刻（还在跑
-- 或没跑完）的取开始时刻。没有回合的会话保持原值——它从没有过活动，等于创建
-- 时刻并没有错。
UPDATE `session` SET `updated_at` = (
  SELECT MAX(COALESCE(`turn`.`completed_at`, `turn`.`created_at`))
  FROM `turn` WHERE `turn`.`session_id` = `session`.`id`
) WHERE EXISTS (
  SELECT 1 FROM `turn` WHERE `turn`.`session_id` = `session`.`id`
);
