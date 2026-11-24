ALTER TABLE `bot` RENAME COLUMN `avatar` TO `avatar_path`;--> statement-breakpoint
UPDATE `bot` SET `avatar_path` = NULL;
