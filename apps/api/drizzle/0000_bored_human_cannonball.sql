CREATE TABLE `dns_providers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`ipv4` text,
	`ipv6` text,
	`doh_url` text,
	`dot_host` text,
	`dnssec` integer DEFAULT false NOT NULL,
	`kind` text DEFAULT 'custom' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `dns_tests` (
	`id` text PRIMARY KEY NOT NULL,
	`test_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`provider_name` text NOT NULL,
	`latency_ms` real,
	`ok` integer NOT NULL,
	`dnssec` integer,
	`transport` text NOT NULL,
	FOREIGN KEY (`test_id`) REFERENCES `network_tests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `endpoint_tests` (
	`id` text PRIMARY KEY NOT NULL,
	`test_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`hostname` text,
	`ping_ms` real,
	`tcp_ms` real,
	`tls_ms` real,
	`http_ms` real,
	`packet_loss` real,
	`score` real,
	`status` text NOT NULL,
	FOREIGN KEY (`test_id`) REFERENCES `network_tests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `ip_lookups` (
	`ip` text PRIMARY KEY NOT NULL,
	`family` integer NOT NULL,
	`data` text NOT NULL,
	`fetched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `network_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`level` text NOT NULL,
	`category` text NOT NULL,
	`message` text NOT NULL,
	`data` text
);
--> statement-breakpoint
CREATE INDEX `idx_network_events_ts` ON `network_events` (`ts`);--> statement-breakpoint
CREATE INDEX `idx_network_events_level_cat` ON `network_events` (`level`,`category`);--> statement-breakpoint
CREATE TABLE `network_tests` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`params` text,
	`summary` text,
	`error` text,
	`started_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_network_tests_type_ts` ON `network_tests` (`type`,`started_at`);--> statement-breakpoint
CREATE TABLE `optimization_results` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`server_id` text,
	`rank` integer NOT NULL,
	`score` real NOT NULL,
	`metrics` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `optimization_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `optimization_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`test_id` text NOT NULL,
	`strategy` text NOT NULL,
	`weights` text NOT NULL,
	`best_server_id` text,
	`result` text,
	FOREIGN KEY (`test_id`) REFERENCES `network_tests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `route_hops` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`route_test_id` text NOT NULL,
	`hop` integer NOT NULL,
	`ip` text,
	`hostname` text,
	`latency_ms` real,
	`packet_loss` real,
	`asn` integer,
	`org` text,
	`country` text,
	`status` text NOT NULL,
	FOREIGN KEY (`route_test_id`) REFERENCES `route_tests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_route_hops_test_hop` ON `route_hops` (`route_test_id`,`hop`);--> statement-breakpoint
CREATE TABLE `route_tests` (
	`id` text PRIMARY KEY NOT NULL,
	`test_id` text NOT NULL,
	`target` text NOT NULL,
	`resolved_ip` text,
	`family` integer NOT NULL,
	`hop_count` integer,
	`total_latency_ms` real,
	`packet_loss` real,
	`score` real,
	`route_hash` text,
	FOREIGN KEY (`test_id`) REFERENCES `network_tests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `server_health` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`server_id` text NOT NULL,
	`checked_at` integer NOT NULL,
	`ping_ms` real,
	`jitter_ms` real,
	`packet_loss` real,
	`download_mbps` real,
	`upload_mbps` real,
	`status` text NOT NULL,
	`health_score` real,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_server_health_server_ts` ON `server_health` (`server_id`,`checked_at`);--> statement-breakpoint
CREATE TABLE `servers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`host` text NOT NULL,
	`ipv4` text,
	`ipv6` text,
	`provider` text,
	`region` text,
	`country` text,
	`city` text,
	`protocol` text,
	`port` integer,
	`capabilities` text NOT NULL,
	`tags` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `speed_tests` (
	`id` text PRIMARY KEY NOT NULL,
	`test_id` text NOT NULL,
	`server` text,
	`download_mbps` real,
	`upload_mbps` real,
	`ping_min` real,
	`ping_avg` real,
	`ping_max` real,
	`ping_median` real,
	`jitter_ms` real,
	`packet_loss` real,
	`duration_ms` integer,
	FOREIGN KEY (`test_id`) REFERENCES `network_tests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`role` text DEFAULT 'admin' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);--> statement-breakpoint
CREATE TABLE `vpn_providers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`config` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `vpn_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`server_id` text,
	`provider_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`public_key` text,
	`allowed_ips` text,
	`meta` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`provider_id`) REFERENCES `vpn_providers`(`id`) ON UPDATE no action ON DELETE cascade
);
