CREATE TABLE `mcp_credential` (
	`server_id` text NOT NULL,
	`kind` text NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	`content` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`server_id`, `kind`)
);
