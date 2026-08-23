CREATE TABLE `asset_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`status` text NOT NULL,
	`style_bible_id` text NOT NULL,
	`style_checksum` text NOT NULL,
	`rig` text,
	`canvas_width` integer NOT NULL,
	`canvas_height` integer NOT NULL,
	`nominal_height` integer NOT NULL,
	`preview_image_hash` text,
	`quality` text NOT NULL,
	`scores` text,
	`rejection_reason` text,
	`provenance` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `asset_versions_asset_ordinal_uq` ON `asset_versions` (`asset_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `asset_versions_asset_idx` ON `asset_versions` (`asset_id`);--> statement-breakpoint
CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`semantic_key` text NOT NULL,
	`style_checksum` text NOT NULL,
	`variant_key` text NOT NULL,
	`spec_hash` text NOT NULL,
	`archetype` text NOT NULL,
	`label` text NOT NULL,
	`description` text NOT NULL,
	`tags` text NOT NULL,
	`current_version_id` text NOT NULL,
	`embedding` blob,
	`embedding_model` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assets_key_uq` ON `assets` (`key`);--> statement-breakpoint
CREATE UNIQUE INDEX `assets_dedup_uq` ON `assets` (`semantic_key`,`style_checksum`,`variant_key`,`spec_hash`);--> statement-breakpoint
CREATE INDEX `assets_semantic_key_idx` ON `assets` (`semantic_key`);--> statement-breakpoint
CREATE INDEX `assets_style_checksum_idx` ON `assets` (`style_checksum`);--> statement-breakpoint
CREATE TABLE `blobs` (
	`hash` text PRIMARY KEY NOT NULL,
	`byte_size` integer NOT NULL,
	`media_type` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `blobs_created_at_idx` ON `blobs` (`created_at`);--> statement-breakpoint
CREATE TABLE `clips` (
	`id` text PRIMARY KEY NOT NULL,
	`version_id` text NOT NULL,
	`name` text NOT NULL,
	`label` text,
	`source` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`fps` integer NOT NULL,
	`loop` text NOT NULL,
	`ir_hash` text NOT NULL,
	`baked_sheet_id` text,
	`tags` text NOT NULL,
	`provenance` text NOT NULL,
	FOREIGN KEY (`version_id`) REFERENCES `asset_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `clips_version_name_uq` ON `clips` (`version_id`,`name`);--> statement-breakpoint
CREATE INDEX `clips_ir_hash_idx` ON `clips` (`ir_hash`);--> statement-breakpoint
CREATE TABLE `entities` (
	`id` text PRIMARY KEY NOT NULL,
	`series_id` text NOT NULL,
	`kind` text NOT NULL,
	`canonical_name` text NOT NULL,
	`aliases` text NOT NULL,
	`summary` text NOT NULL,
	`first_appearance_ordinal` integer NOT NULL,
	`first_appearance_label` text,
	`importance` text NOT NULL,
	`asset_refs` text NOT NULL,
	`payload` text NOT NULL,
	`embedding` blob,
	`embedding_model` text
);
--> statement-breakpoint
CREATE INDEX `entities_series_idx` ON `entities` (`series_id`);--> statement-breakpoint
CREATE INDEX `entities_series_kind_idx` ON `entities` (`series_id`,`kind`);--> statement-breakpoint
CREATE INDEX `entities_canonical_name_idx` ON `entities` (`canonical_name`);--> statement-breakpoint
CREATE TABLE `episodes` (
	`id` text PRIMARY KEY NOT NULL,
	`series_id` text NOT NULL,
	`season_id` text,
	`ordinal` integer NOT NULL,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`planned_summary` text,
	`status` text NOT NULL,
	`logline` text NOT NULL,
	`cold_open` text,
	`cliffhanger` text,
	`opens_loops` text NOT NULL,
	`closes_loops` text NOT NULL,
	`aired_at` text,
	`structure` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `episodes_series_ordinal_uq` ON `episodes` (`series_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `episodes_series_status_idx` ON `episodes` (`series_id`,`status`);--> statement-breakpoint
CREATE TABLE `facts` (
	`id` text PRIMARY KEY NOT NULL,
	`series_id` text NOT NULL,
	`holder_id` text NOT NULL,
	`relation_id` text NOT NULL,
	`fact` text NOT NULL,
	`via` text NOT NULL,
	`learned_at_ordinal` integer,
	`learned_at_label` text,
	`learned_from_entity_id` text,
	`confidence` real NOT NULL,
	FOREIGN KEY (`holder_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`relation_id`) REFERENCES `relations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `facts_series_holder_idx` ON `facts` (`series_id`,`holder_id`);--> statement-breakpoint
CREATE INDEX `facts_relation_idx` ON `facts` (`relation_id`);--> statement-breakpoint
CREATE INDEX `facts_learned_at_idx` ON `facts` (`series_id`,`learned_at_ordinal`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`stage` text NOT NULL,
	`state` text NOT NULL,
	`attempt` integer NOT NULL,
	`payload` text NOT NULL,
	`result` text,
	`error_code` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `jobs_run_idx` ON `jobs` (`run_id`);--> statement-breakpoint
CREATE INDEX `jobs_state_idx` ON `jobs` (`state`);--> statement-breakpoint
CREATE INDEX `jobs_run_stage_idx` ON `jobs` (`run_id`,`stage`);--> statement-breakpoint
CREATE TABLE `parts` (
	`id` text PRIMARY KEY NOT NULL,
	`version_id` text NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`image_hash` text NOT NULL,
	`bounds_x` real NOT NULL,
	`bounds_y` real NOT NULL,
	`bounds_width` real NOT NULL,
	`bounds_height` real NOT NULL,
	`size_width` integer NOT NULL,
	`size_height` integer NOT NULL,
	`pivot_x` real NOT NULL,
	`pivot_y` real NOT NULL,
	`z_order` integer NOT NULL,
	`deformable` integer NOT NULL,
	`alpha_coverage` real NOT NULL,
	FOREIGN KEY (`version_id`) REFERENCES `asset_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `parts_version_name_uq` ON `parts` (`version_id`,`name`);--> statement-breakpoint
CREATE INDEX `parts_image_hash_idx` ON `parts` (`image_hash`);--> statement-breakpoint
CREATE TABLE `relations` (
	`id` text PRIMARY KEY NOT NULL,
	`series_id` text NOT NULL,
	`from_entity_id` text NOT NULL,
	`to_entity_id` text NOT NULL,
	`type` text NOT NULL,
	`fact` text NOT NULL,
	`strength` real NOT NULL,
	`valid_from_ordinal` integer,
	`valid_from_label` text,
	`valid_until_ordinal` integer,
	`valid_until_label` text,
	`asserted_at` text NOT NULL,
	`retracted_at` text,
	`source_ref` text NOT NULL,
	`confidence` real NOT NULL,
	`visibility` text NOT NULL,
	FOREIGN KEY (`from_entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `relations_series_from_idx` ON `relations` (`series_id`,`from_entity_id`);--> statement-breakpoint
CREATE INDEX `relations_series_to_idx` ON `relations` (`series_id`,`to_entity_id`);--> statement-breakpoint
CREATE INDEX `relations_series_type_idx` ON `relations` (`series_id`,`type`);--> statement-breakpoint
CREATE INDEX `relations_valid_from_idx` ON `relations` (`series_id`,`valid_from_ordinal`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`stage` text NOT NULL,
	`state` text NOT NULL,
	`budget_nano_usd` integer,
	`spent_nano_usd` integer NOT NULL,
	`seed` integer NOT NULL,
	`error_code` text,
	`metadata` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text
);
--> statement-breakpoint
CREATE INDEX `runs_project_idx` ON `runs` (`project_id`);--> statement-breakpoint
CREATE INDEX `runs_state_idx` ON `runs` (`state`);--> statement-breakpoint
CREATE TABLE `scenes` (
	`id` text PRIMARY KEY NOT NULL,
	`episode_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`planned_summary` text,
	`location_ref` text NOT NULL,
	`pov_entity_ref` text,
	`present_entity_refs` text NOT NULL,
	`goal` text NOT NULL,
	`conflict` text NOT NULL,
	`outcome` text NOT NULL,
	`from_ordinal` integer,
	`from_label` text,
	`until_ordinal` integer,
	`until_label` text,
	`value_shift` text NOT NULL,
	`beats` text NOT NULL,
	FOREIGN KEY (`episode_id`) REFERENCES `episodes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scenes_episode_ordinal_uq` ON `scenes` (`episode_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `scenes_location_idx` ON `scenes` (`location_ref`);--> statement-breakpoint
CREATE INDEX `scenes_from_ordinal_idx` ON `scenes` (`from_ordinal`);--> statement-breakpoint
CREATE TABLE `shots` (
	`id` text PRIMARY KEY NOT NULL,
	`scene_id` text NOT NULL,
	`index` integer NOT NULL,
	`duration_ms` integer NOT NULL,
	`beat_ref` text NOT NULL,
	`scene_space` text NOT NULL,
	`camera` text NOT NULL,
	`layout` text NOT NULL,
	`blocking` text NOT NULL,
	`dialogue` text NOT NULL,
	`audio` text NOT NULL,
	`safe_area` text NOT NULL,
	`focus_target` text NOT NULL,
	FOREIGN KEY (`scene_id`) REFERENCES `scenes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shots_scene_index_uq` ON `shots` (`scene_id`,`index`);--> statement-breakpoint
CREATE INDEX `shots_beat_idx` ON `shots` (`beat_ref`);--> statement-breakpoint
CREATE TABLE `sprite_sheets` (
	`id` text PRIMARY KEY NOT NULL,
	`clip_id` text NOT NULL,
	`atlas_image_hash` text NOT NULL,
	`atlas_json_hash` text NOT NULL,
	`frame_count` integer NOT NULL,
	`fps` integer NOT NULL,
	`frame_width` integer NOT NULL,
	`frame_height` integer NOT NULL,
	`atlas_width` integer NOT NULL,
	`atlas_height` integer NOT NULL,
	`frames` text NOT NULL,
	`trimmed` integer NOT NULL,
	`padding` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`clip_id`) REFERENCES `clips`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sprite_sheets_clip_idx` ON `sprite_sheets` (`clip_id`);--> statement-breakpoint
CREATE TABLE `style_bibles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`version` integer NOT NULL,
	`origin` text NOT NULL,
	`parent_id` text,
	`visual` text NOT NULL,
	`motion` text NOT NULL,
	`render` text NOT NULL,
	`prompts` text NOT NULL,
	`anchors` text NOT NULL,
	`seed` integer NOT NULL,
	`checksum` text NOT NULL,
	`locked_at` text,
	`created_at` text NOT NULL,
	`notes` text
);
--> statement-breakpoint
CREATE INDEX `style_bibles_checksum_idx` ON `style_bibles` (`checksum`);--> statement-breakpoint
CREATE INDEX `style_bibles_parent_idx` ON `style_bibles` (`parent_id`);--> statement-breakpoint
CREATE TABLE `usage_records` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`job_id` text,
	`stage` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`task` text NOT NULL,
	`tier` text NOT NULL,
	`tokens_input` integer NOT NULL,
	`tokens_output` integer NOT NULL,
	`tokens_cached` integer NOT NULL,
	`tokens_reasoning` integer NOT NULL,
	`image_count` integer NOT NULL,
	`image_resolution` text,
	`latency_ms` integer NOT NULL,
	`cost_nano_usd` integer NOT NULL,
	`outcome` text NOT NULL,
	`error_code` text,
	`cache_hit` integer NOT NULL,
	`at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `usage_records_run_idx` ON `usage_records` (`run_id`);--> statement-breakpoint
CREATE INDEX `usage_records_job_idx` ON `usage_records` (`job_id`);--> statement-breakpoint
CREATE INDEX `usage_records_provider_at_idx` ON `usage_records` (`provider`,`at`);--> statement-breakpoint
CREATE INDEX `usage_records_stage_idx` ON `usage_records` (`stage`);--> statement-breakpoint
CREATE TABLE `variants` (
	`id` text PRIMARY KEY NOT NULL,
	`version_id` text NOT NULL,
	`key` text NOT NULL,
	`label` text NOT NULL,
	`replaced_parts` text NOT NULL,
	`validity` text,
	`valid_from_ordinal` integer,
	`valid_until_ordinal` integer,
	`provenance` text NOT NULL,
	FOREIGN KEY (`version_id`) REFERENCES `asset_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `variants_version_key_idx` ON `variants` (`version_id`,`key`);--> statement-breakpoint
CREATE INDEX `variants_valid_from_idx` ON `variants` (`valid_from_ordinal`);