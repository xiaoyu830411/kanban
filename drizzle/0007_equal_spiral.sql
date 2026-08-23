ALTER TABLE `tasks` ADD `execution_type` enum('tmp','dir','repo') DEFAULT 'tmp' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `execution_target` varchar(500);