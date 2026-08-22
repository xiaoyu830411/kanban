CREATE TABLE `task_comments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`task_id` int NOT NULL,
	`kind` enum('comment','report') NOT NULL DEFAULT 'comment',
	`author_type` enum('member','agent') NOT NULL,
	`author_id` int NOT NULL,
	`body` text NOT NULL,
	`changed_files` json NOT NULL DEFAULT ('[]'),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `task_comments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `task_dod_items` (
	`id` int AUTO_INCREMENT NOT NULL,
	`task_id` int NOT NULL,
	`content` varchar(500) NOT NULL,
	`position` int NOT NULL DEFAULT 0,
	`checked` boolean NOT NULL DEFAULT false,
	`evidence` text,
	`checked_by_type` enum('member','agent'),
	`checked_by_id` int,
	`checked_at` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `task_dod_items_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `task_comments` ADD CONSTRAINT `task_comments_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `task_dod_items` ADD CONSTRAINT `task_dod_items_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE no action ON UPDATE no action;