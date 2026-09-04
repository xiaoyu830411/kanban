CREATE TABLE `task_runs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`task_id` int NOT NULL,
	`agent_id` int NOT NULL,
	`origin` enum('registered','launched') NOT NULL,
	`agent_type` enum('claude_code','codex') NOT NULL DEFAULT 'claude_code',
	`session_id` varchar(64) NOT NULL,
	`cwd` varchar(500) NOT NULL,
	`status` enum('running','idle','finished','interrupted') NOT NULL DEFAULT 'running',
	`end_cause` varchar(64),
	`stop_reason` varchar(32),
	`last_entry_at` timestamp(3),
	`title_applied` boolean NOT NULL DEFAULT false,
	`revertible` boolean NOT NULL DEFAULT false,
	`git_baseline` varchar(64),
	`changed_files` json NOT NULL DEFAULT ('[]'),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `task_runs_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_task_runs_agent_session` UNIQUE(`agent_type`,`session_id`)
);
--> statement-breakpoint
ALTER TABLE `task_runs` ADD CONSTRAINT `task_runs_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `task_runs` ADD CONSTRAINT `task_runs_agent_id_agents_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON DELETE no action ON UPDATE no action;