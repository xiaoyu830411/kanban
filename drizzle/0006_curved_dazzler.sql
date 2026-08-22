CREATE TABLE `activity_records` (
	`id` int AUTO_INCREMENT NOT NULL,
	`task_id` int NOT NULL,
	`actor_type` enum('member','agent') NOT NULL,
	`actor_id` int NOT NULL,
	`action` varchar(32) NOT NULL,
	`detail` json NOT NULL DEFAULT ('{}'),
	`occurred_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `activity_records_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_activity_task_time` ON `activity_records` (`task_id`,`id`);