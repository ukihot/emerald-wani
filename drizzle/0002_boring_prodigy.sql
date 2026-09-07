CREATE TABLE `two_factor` (
	`id` text PRIMARY KEY NOT NULL,
	`secret` text NOT NULL,
	`backup_codes` text NOT NULL,
	`user_id` text NOT NULL,
	`verified` integer DEFAULT true,
	`failed_verification_count` integer DEFAULT 0,
	`locked_until` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `twoFactor_secret_idx` ON `two_factor` (`secret`);--> statement-breakpoint
CREATE INDEX `twoFactor_userId_idx` ON `two_factor` (`user_id`);--> statement-breakpoint
CREATE TABLE `admin_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`ts` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`admin_user_id` text NOT NULL,
	`action` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`detail_json` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `admin_audit_ts_idx` ON `admin_audit` (`ts`);--> statement-breakpoint
CREATE INDEX `admin_audit_admin_ts_idx` ON `admin_audit` (`admin_user_id`,`ts`);--> statement-breakpoint
CREATE TABLE `security_event` (
	`id` text PRIMARY KEY NOT NULL,
	`ts` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`type` text NOT NULL,
	`severity` text NOT NULL,
	`user_id` text,
	`ip_hash` text,
	`ua_hash` text,
	`detail_json` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `security_event_ts_idx` ON `security_event` (`ts`);--> statement-breakpoint
CREATE INDEX `security_event_userId_ts_idx` ON `security_event` (`user_id`,`ts`);--> statement-breakpoint
CREATE INDEX `security_event_type_ts_idx` ON `security_event` (`type`,`ts`);--> statement-breakpoint
ALTER TABLE `session` ADD `impersonated_by` text;--> statement-breakpoint
ALTER TABLE `user` ADD `role` text;--> statement-breakpoint
ALTER TABLE `user` ADD `banned` integer DEFAULT false;--> statement-breakpoint
ALTER TABLE `user` ADD `ban_reason` text;--> statement-breakpoint
ALTER TABLE `user` ADD `ban_expires` integer;--> statement-breakpoint
ALTER TABLE `user` ADD `two_factor_enabled` integer DEFAULT false;