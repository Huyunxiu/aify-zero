-- 收件箱改名不改数据：表、两列和取值都换成「待办项」的说法。
ALTER TABLE `inbox_message` RENAME TO `inbox_item`;--> statement-breakpoint
ALTER TABLE `inbox_item` RENAME COLUMN `request_id` TO `dedupe_key`;--> statement-breakpoint
ALTER TABLE `inbox_item` RENAME COLUMN `placement` TO `deliver_at`;--> statement-breakpoint
UPDATE `inbox_item` SET `deliver_at` = CASE `deliver_at`
	WHEN 'next-step' THEN 'step-boundary'
	WHEN 'next-turn' THEN 'run-boundary'
	ELSE `deliver_at`
END;--> statement-breakpoint
ALTER TABLE `inbox_item` ADD `kind` text DEFAULT 'user-message' NOT NULL;--> statement-breakpoint
DROP INDEX `inbox_message_id_unique`;--> statement-breakpoint
DROP INDEX `idx_inbox_session_request`;--> statement-breakpoint
DROP INDEX `idx_inbox_session_placement_seq`;--> statement-breakpoint
CREATE UNIQUE INDEX `inbox_item_id_unique` ON `inbox_item` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_inbox_session_dedupe` ON `inbox_item` (`session_id`,`dedupe_key`);--> statement-breakpoint
CREATE INDEX `idx_inbox_session_delivery_seq` ON `inbox_item` (`session_id`,`deliver_at`,`seq`);
