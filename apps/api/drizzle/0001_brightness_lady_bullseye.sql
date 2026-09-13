CREATE TABLE `cloudflare_scans` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`config` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`discovered` integer DEFAULT 0 NOT NULL,
	`tested` integer DEFAULT 0 NOT NULL,
	`alive` integer DEFAULT 0 NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE TABLE `cloudflare_candidates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scan_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`port` integer NOT NULL,
	`tcp_ms` real,
	`tls_ms` real,
	`http_ms` real,
	`http_status` integer,
	`icmp_avg_ms` real,
	`score` real,
	`status` text NOT NULL,
	`label` text NOT NULL,
	`favorite` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`scan_id`) REFERENCES `cloudflare_scans`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_cf_candidates_scan_score` ON `cloudflare_candidates` (`scan_id`,`score`);
--> statement-breakpoint
CREATE TABLE `stability_samples` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`t` integer NOT NULL,
	`latency_ms` real,
	`jitter_ms` real,
	`loss_pct` real,
	`dns_ms` real,
	`online` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_stability_t` ON `stability_samples` (`t`);
--> statement-breakpoint
CREATE TABLE `bufferbloat_tests` (
	`id` text PRIMARY KEY NOT NULL,
	`test_id` text NOT NULL,
	`idle_latency_ms` real,
	`download_load_ms` real,
	`upload_load_ms` real,
	`download_increase_ms` real,
	`upload_increase_ms` real,
	`grade` text,
	FOREIGN KEY (`test_id`) REFERENCES `network_tests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `route_comparisons` (
	`id` text PRIMARY KEY NOT NULL,
	`test_id` text NOT NULL,
	`target` text NOT NULL,
	`routes` text NOT NULL,
	`winner` text,
	`reason` text,
	FOREIGN KEY (`test_id`) REFERENCES `network_tests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `vpn_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`server_id` text,
	`server_name` text,
	`endpoint` text,
	`protocol` text NOT NULL,
	`status` text NOT NULL,
	`connected_at` integer,
	`disconnected_at` integer,
	`rx_bytes` integer,
	`tx_bytes` integer,
	`error` text
);
