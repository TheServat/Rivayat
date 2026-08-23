CREATE TABLE `settings` (
	`scope` text NOT NULL,
	`scope_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`scope`, `scope_id`, `key`)
);
--> statement-breakpoint
CREATE INDEX `settings_scope_idx` ON `settings` (`scope`,`scope_id`);--> statement-breakpoint
CREATE INDEX `settings_key_idx` ON `settings` (`key`);