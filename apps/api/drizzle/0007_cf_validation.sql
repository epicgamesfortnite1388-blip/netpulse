ALTER TABLE `cloudflare_candidates` ADD `colo` text;
--> statement-breakpoint
ALTER TABLE `cloudflare_candidates` ADD `loc` text;
--> statement-breakpoint
ALTER TABLE `cloudflare_candidates` ADD `loss_pct` real;
--> statement-breakpoint
ALTER TABLE `cloudflare_candidates` ADD `jitter_ms` real;
--> statement-breakpoint
ALTER TABLE `cloudflare_candidates` ADD `download_mbps` real;
--> statement-breakpoint
ALTER TABLE `cloudflare_candidates` ADD `ttfb_ms` real;
--> statement-breakpoint
ALTER TABLE `cloudflare_candidates` ADD `validated` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `cloudflare_candidates` ADD `clean` integer;
--> statement-breakpoint
CREATE INDEX `idx_cf_candidates_scan_clean` ON `cloudflare_candidates` (`scan_id`, `clean`);
