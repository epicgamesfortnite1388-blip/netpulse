CREATE TABLE `map_observations` (
	`id` text PRIMARY KEY NOT NULL,
	`target_id` text NOT NULL,
	`target_type` text NOT NULL,
	`name` text NOT NULL,
	`family` integer,
	`ip` text,
	`protocol` text,
	`port` integer,
	`vpn_active` integer DEFAULT 0 NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_map_observations_target_ts` ON `map_observations` (`target_id`, `created_at`);