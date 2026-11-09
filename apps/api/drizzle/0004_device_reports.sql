CREATE TABLE `vault_device_report` (
	`vault_id` text NOT NULL,
	`local_vault_id` text NOT NULL,
	`user_id` text NOT NULL,
	`platform` text NOT NULL,
	`plugin_version` text NOT NULL,
	`report_json` text NOT NULL,
	`details_envelope` text,
	`reported_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`vault_id`, `local_vault_id`),
	FOREIGN KEY (`vault_id`) REFERENCES `vault`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `vault_device_report_reported_idx` ON `vault_device_report` (`vault_id`,`reported_at`);