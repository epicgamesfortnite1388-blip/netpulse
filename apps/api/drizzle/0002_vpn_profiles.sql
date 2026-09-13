CREATE TABLE `vpn_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`name` text NOT NULL,
	`protocol` text NOT NULL,
	`endpoint` text,
	`public_key_fingerprint` text,
	`allowed_ips` text,
	`dns_servers` text,
	`secret_ref` text NOT NULL,
	`config_path` text NOT NULL,
	`last_used_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_vpn_profiles_created` ON `vpn_profiles` (`created_at`);
