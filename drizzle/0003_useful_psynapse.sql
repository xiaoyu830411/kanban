CREATE TABLE `tasks` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspace_id` int NOT NULL,
	`title` varchar(200) NOT NULL,
	`description` text NOT NULL DEFAULT (''),
	`priority` enum('low','medium','high','urgent') NOT NULL DEFAULT 'medium',
	`labels` json NOT NULL DEFAULT ('[]'),
	`column` enum('to_plan','todo','in_progress','in_review','done') NOT NULL DEFAULT 'to_plan',
	`assignee_agent_id` int,
	`held_by_agent_id` int,
	`created_by_id` int NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `tasks_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_workspace_id_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_created_by_id_members_id_fk` FOREIGN KEY (`created_by_id`) REFERENCES `members`(`id`) ON DELETE no action ON UPDATE no action;