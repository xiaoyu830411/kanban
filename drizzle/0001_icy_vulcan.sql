CREATE TABLE `member_sessions` (
	`token_hash` varchar(64) NOT NULL,
	`member_id` int NOT NULL,
	`expires_at` timestamp(3) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `member_sessions_token_hash` PRIMARY KEY(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `members` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(64) NOT NULL,
	`external_id` varchar(191) NOT NULL,
	`role` enum('admin','member') NOT NULL DEFAULT 'member',
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `members_id` PRIMARY KEY(`id`),
	CONSTRAINT `members_external_id_unique` UNIQUE(`external_id`)
);
--> statement-breakpoint
ALTER TABLE `member_sessions` ADD CONSTRAINT `member_sessions_member_id_members_id_fk` FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON DELETE no action ON UPDATE no action;