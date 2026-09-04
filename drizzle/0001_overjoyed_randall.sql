CREATE TABLE `match` (
	`id` text PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	`rule_version` text NOT NULL,
	`map_version` text NOT NULL,
	`map_seed` text NOT NULL,
	`status` text NOT NULL,
	`winner_seat` integer,
	`end_reason` text,
	`round_count` integer DEFAULT 0 NOT NULL,
	`score_seat0` integer DEFAULT 0 NOT NULL,
	`score_seat1` integer DEFAULT 0 NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`replay_key` text
);
--> statement-breakpoint
CREATE INDEX `match_endedAt_idx` ON `match` (`ended_at`);--> statement-breakpoint
CREATE INDEX `match_version_status_idx` ON `match` (`rule_version`,`map_version`,`status`);--> statement-breakpoint
CREATE INDEX `match_replayKey_idx` ON `match` (`replay_key`);--> statement-breakpoint
CREATE TABLE `match_player` (
	`match_id` text NOT NULL,
	`seat` integer NOT NULL,
	`user_id` text NOT NULL,
	`result` text NOT NULL,
	FOREIGN KEY (`match_id`) REFERENCES `match`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `match_player_pk` ON `match_player` (`match_id`,`seat`);--> statement-breakpoint
CREATE INDEX `match_player_userId_matchId_idx` ON `match_player` (`user_id`,`match_id`);--> statement-breakpoint
CREATE TABLE `player_profile` (
	`user_id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`icon_id` text,
	`settings_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `report` (
	`id` text PRIMARY KEY NOT NULL,
	`reporter_user_id` text NOT NULL,
	`target_user_id` text NOT NULL,
	`match_id` text,
	`reason` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `report_reporter_target_match_uidx` ON `report` (`reporter_user_id`,`target_user_id`,`match_id`);--> statement-breakpoint
CREATE INDEX `report_target_createdAt_idx` ON `report` (`target_user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `report_status_createdAt_idx` ON `report` (`status`,`created_at`);