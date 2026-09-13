CREATE TABLE `gaming_session_samples` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`game_id` text NOT NULL,
	`endpoint` text,
	`ts` integer NOT NULL,
	`latency_ms` real,
	`jitter_ms` real,
	`loss_pct` real,
	`online` integer NOT NULL,
	`public_ip` text,
	`vpn_active` integer NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX `idx_gaming_session_samples_ts` ON `gaming_session_samples` (`session_id`, `ts`);
--> statement-breakpoint
CREATE TABLE `gaming_comparisons` (
	`id` text PRIMARY KEY NOT NULL,
	`test_id` text NOT NULL REFERENCES `network_tests`(`id`) ON UPDATE no action ON DELETE cascade,
	`game_id` text NOT NULL,
	`mode` text NOT NULL,
	`server_name` text,
	`latency_ms` real,
	`jitter_ms` real,
	`loss_pct` real,
	`score` real,
	`notes` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_gaming_comparisons_game_ts` ON `gaming_comparisons` (`game_id`, `created_at`);
