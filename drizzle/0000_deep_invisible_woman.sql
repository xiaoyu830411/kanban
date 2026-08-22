CREATE TABLE `system_pings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`source` varchar(64) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `system_pings_id` PRIMARY KEY(`id`)
);
