CREATE TABLE `iran_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_iran_sessions_created` ON `iran_sessions` (`created_at`);
--> statement-breakpoint
CREATE TABLE `iran_measurements` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`target_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`connection_name` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_iran_measurements_session` ON `iran_measurements` (`session_id`);
--> statement-breakpoint
CREATE INDEX `idx_iran_measurements_target_ts` ON `iran_measurements` (`target_id`, `created_at`);