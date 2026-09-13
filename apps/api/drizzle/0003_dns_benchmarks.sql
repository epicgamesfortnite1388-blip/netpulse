CREATE TABLE `dns_benchmarks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`test_id` text NOT NULL REFERENCES `network_tests`(`id`) ON UPDATE no action ON DELETE cascade,
	`provider_id` text NOT NULL,
	`provider_name` text NOT NULL,
	`transport` text NOT NULL,
	`queries` integer NOT NULL,
	`ok` integer NOT NULL,
	`timeouts` integer NOT NULL,
	`errors` integer NOT NULL,
	`latency_min_ms` real,
	`latency_avg_ms` real,
	`latency_median_ms` real,
	`latency_max_ms` real,
	`latency_p95_ms` real,
	`jitter_ms` real,
	`reliability_pct` real,
	`score` real,
	`dnssec` integer,
	`ipv6_ok` integer,
	`error` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_dns_benchmarks_provider_ts` ON `dns_benchmarks` (`provider_id`, `transport`, `created_at`);
--> statement-breakpoint
CREATE INDEX `idx_dns_benchmarks_test` ON `dns_benchmarks` (`test_id`);
