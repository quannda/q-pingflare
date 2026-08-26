-- Cuts D1 rows-read by ~4 orders of magnitude.
--
-- Before: status_logs had no secondary index, so every query filtering by
-- monitor_id or checked_at was a full table scan, and every long-range uptime
-- query read every log row for the window.
--
-- After: one composite index makes the hot lookups seekable, and daily_stats
-- pre-aggregates history so a 90-day chart reads 90 rows instead of ~130k.

CREATE INDEX IF NOT EXISTS `idx_status_logs_monitor_checked` ON `status_logs` (`monitor_id`, `checked_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_incidents_monitor_started` ON `incidents` (`monitor_id`, `started_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_incident_monitors_monitor` ON `incident_monitors` (`monitor_id`);
--> statement-breakpoint
-- WITHOUT ROWID: the primary key IS the storage, so an upsert costs one row
-- written instead of two (table row + autoindex entry).
CREATE TABLE IF NOT EXISTS `daily_stats` (
	`monitor_id` text NOT NULL,
	`day` integer NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`ups` integer DEFAULT 0 NOT NULL,
	`rt_sum` integer DEFAULT 0 NOT NULL,
	`rt_count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`monitor_id`, `day`),
	FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON UPDATE no action ON DELETE cascade
) WITHOUT ROWID;
--> statement-breakpoint
-- One-time backfill from the raw logs that already exist.
INSERT INTO `daily_stats` (`monitor_id`, `day`, `total`, `ups`, `rt_sum`, `rt_count`)
SELECT
	`monitor_id`,
	`checked_at` / 86400,
	COUNT(*),
	SUM(CASE WHEN `status` = 'up' THEN 1 ELSE 0 END),
	COALESCE(SUM(`response_time_ms`), 0),
	COUNT(`response_time_ms`)
FROM `status_logs`
GROUP BY `monitor_id`, `checked_at` / 86400
ON CONFLICT (`monitor_id`, `day`) DO NOTHING;
--> statement-breakpoint
INSERT OR IGNORE INTO `settings` (`key`, `value`) VALUES ('stats_retention_days', '400');
--> statement-breakpoint
INSERT OR IGNORE INTO `settings` (`key`, `value`) VALUES ('cache_ttl', '900');
--> statement-breakpoint
INSERT INTO `settings` (`key`, `value`) VALUES ('schema_version', '2')
	ON CONFLICT (`key`) DO UPDATE SET `value` = excluded.`value`;
