DROP INDEX "idx_auth_login_ticket_instance";--> statement-breakpoint
DROP INDEX "idx_auth_session_user";--> statement-breakpoint
DROP INDEX "idx_auth_session_expires";--> statement-breakpoint
DROP INDEX "inbox_item_id_unique";--> statement-breakpoint
DROP INDEX "idx_inbox_session_dedupe";--> statement-breakpoint
DROP INDEX "idx_inbox_session_delivery_seq";--> statement-breakpoint
DROP INDEX "idx_outbox_session_turn";--> statement-breakpoint
DROP INDEX "idx_outbox_pending";--> statement-breakpoint
DROP INDEX "idx_outbox_created";--> statement-breakpoint
DROP INDEX "idx_project_primary_dir";--> statement-breakpoint
DROP INDEX "idx_session_kind_updated";--> statement-breakpoint
DROP INDEX "idx_session_project_kind_updated";--> statement-breakpoint
DROP INDEX "idx_session_parent_tool_call";--> statement-breakpoint
DROP INDEX "idx_step_session_step";--> statement-breakpoint
DROP INDEX "idx_step_turn_seq";--> statement-breakpoint
DROP INDEX "idx_step_session_created";--> statement-breakpoint
DROP INDEX "idx_timer_session_tool_call";--> statement-breakpoint
DROP INDEX "idx_timer_due";--> statement-breakpoint
DROP INDEX "idx_timer_session_due";--> statement-breakpoint
DROP INDEX "idx_turn_session_turn";--> statement-breakpoint
DROP INDEX "idx_turn_session_parent";--> statement-breakpoint
ALTER TABLE `session` ALTER COLUMN "approval_policy" TO "approval_policy" text NOT NULL DEFAULT 'edit';--> statement-breakpoint
-- The old tier is gone from the picker. A stored row keeps the closest tier it can still be
-- changed from, so an upgrade loosens one question instead of leaving a value nobody can pick.
UPDATE `session` SET `approval_policy` = 'edit' WHERE `approval_policy` IN ('standard', 'cautious');--> statement-breakpoint
CREATE INDEX `idx_auth_login_ticket_instance` ON `auth_login_ticket` (`instance`);--> statement-breakpoint
CREATE INDEX `idx_auth_session_user` ON `auth_session` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_auth_session_expires` ON `auth_session` (`expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `inbox_item_id_unique` ON `inbox_item` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_inbox_session_dedupe` ON `inbox_item` (`session_id`,`dedupe_key`);--> statement-breakpoint
CREATE INDEX `idx_inbox_session_delivery_seq` ON `inbox_item` (`session_id`,`deliver_at`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_outbox_session_turn` ON `outbox_item` (`session_id`,`turn_id`);--> statement-breakpoint
CREATE INDEX `idx_outbox_pending` ON `outbox_item` (`delivered_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_outbox_created` ON `outbox_item` (`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_project_primary_dir` ON `project` (`primary_dir`);--> statement-breakpoint
CREATE INDEX `idx_session_kind_updated` ON `session` (`kind`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_session_project_kind_updated` ON `session` (`project_id`,`kind`,`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_session_parent_tool_call` ON `session` (`parent_session_id`,`parent_tool_call_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_step_session_step` ON `step` (`session_id`,`step_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_step_turn_seq` ON `step` (`session_id`,`turn_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_step_session_created` ON `step` (`session_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_timer_session_tool_call` ON `timer` (`session_id`,`tool_call_id`);--> statement-breakpoint
CREATE INDEX `idx_timer_due` ON `timer` (`due_at`);--> statement-breakpoint
CREATE INDEX `idx_timer_session_due` ON `timer` (`session_id`,`due_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_turn_session_turn` ON `turn` (`session_id`,`turn_id`);--> statement-breakpoint
CREATE INDEX `idx_turn_session_parent` ON `turn` (`session_id`,`parent_id`);