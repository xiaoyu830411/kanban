CREATE TABLE `workspaces` (
	`id` int AUTO_INCREMENT NOT NULL,
	`owner_id` int NOT NULL,
	`kind` enum('my_space') NOT NULL DEFAULT 'my_space',
	`name` varchar(64) NOT NULL DEFAULT '我的空间',
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `workspaces_id` PRIMARY KEY(`id`),
	CONSTRAINT `workspaces_owner_id_unique` UNIQUE(`owner_id`)
);
--> statement-breakpoint
ALTER TABLE `workspaces` ADD CONSTRAINT `workspaces_owner_id_members_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `members`(`id`) ON DELETE no action ON UPDATE no action;