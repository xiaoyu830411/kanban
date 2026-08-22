CREATE TABLE `agents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`owner_id` int NOT NULL,
	`name` varchar(64) NOT NULL,
	`token_hash` varchar(64) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `agents_id` PRIMARY KEY(`id`),
	CONSTRAINT `agents_token_hash_unique` UNIQUE(`token_hash`)
);
--> statement-breakpoint
ALTER TABLE `agents` ADD CONSTRAINT `agents_owner_id_members_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `members`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_assignee_agent_id_agents_id_fk` FOREIGN KEY (`assignee_agent_id`) REFERENCES `agents`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_held_by_agent_id_agents_id_fk` FOREIGN KEY (`held_by_agent_id`) REFERENCES `agents`(`id`) ON DELETE no action ON UPDATE no action;