CREATE TABLE `bot` (
	`id` text(36) PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`avatar` text,
	`description` text,
	`instructions` text,
	`default_model` text,
	`default_effort` text,
	`default_project_id` text,
	`workspace_dir` text,
	`default_approval_policy` text DEFAULT 'edit' NOT NULL,
	`tool_groups` text DEFAULT '{"files":true,"shell":true,"web":true,"jobs":true,"timers":true,"subagent":true}' NOT NULL,
	`sandbox` text DEFAULT '{"adapter":"inherit","isolateHome":false}' NOT NULL,
	`env` text DEFAULT '{}' NOT NULL,
	`skills` text DEFAULT '{"globalMode":"none","globalNames":[]}' NOT NULL,
	`mcp` text DEFAULT '{"globalMode":"selected","globalServerIds":[],"servers":[]}' NOT NULL,
	`include_global_context` integer DEFAULT false NOT NULL,
	`compaction` text,
	`deleted_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_bot_deleted_created` ON `bot` (`deleted_at`,`created_at`);--> statement-breakpoint
DROP TABLE `agent`;--> statement-breakpoint
ALTER TABLE `session` ADD `bot_id` text DEFAULT 'default' NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_session_bot_kind_updated` ON `session` (`bot_id`,`kind`,`updated_at`);--> statement-breakpoint
INSERT OR IGNORE INTO `bot` (`id`, `name`, `skills`, `mcp`, `include_global_context`) VALUES ('default', 'Default', '{"globalMode":"all","globalNames":[]}', '{"globalMode":"all","globalServerIds":[],"servers":[]}', 1);