-- ─────────────────────────────────────────────────────────────────────────────
-- 1. `facts` stored beliefs. Rename it, and give facts a table of their own.
--
-- Forward-only and non-destructive: the belief rows are renamed in place, not
-- re-created, so nothing is copied and nothing can be lost between two statements.
-- The ids move from the `fct_` space to `bel_` by prefix swap - the ULID body is
-- preserved, so the rename is deterministic, collision-free and legible in a log next
-- to whatever referenced it before.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE `facts` RENAME TO `beliefs`;--> statement-breakpoint
ALTER TABLE `beliefs` RENAME COLUMN `fact` TO `proposition`;--> statement-breakpoint
DROP INDEX `facts_series_holder_idx`;--> statement-breakpoint
DROP INDEX `facts_relation_idx`;--> statement-breakpoint
DROP INDEX `facts_learned_at_idx`;--> statement-breakpoint
CREATE INDEX `beliefs_series_holder_idx` ON `beliefs` (`series_id`,`holder_id`);--> statement-breakpoint
CREATE INDEX `beliefs_relation_idx` ON `beliefs` (`relation_id`);--> statement-breakpoint
CREATE INDEX `beliefs_learned_at_idx` ON `beliefs` (`series_id`,`learned_at_ordinal`);--> statement-breakpoint
UPDATE `beliefs` SET `id` = 'bel_' || substr(`id`, 5) WHERE substr(`id`, 1, 4) = 'fct_';--> statement-breakpoint

CREATE TABLE `facts` (
	`id` text PRIMARY KEY NOT NULL,
	`series_id` text NOT NULL,
	`content_kind` text NOT NULL,
	`relation_id` text,
	`text` text,
	`covers` text,
	`valid_from_ordinal` integer,
	`valid_from_label` text,
	`valid_until_ordinal` integer,
	`valid_until_label` text,
	`asserted_at` text NOT NULL,
	`retracted_at` text,
	`source_ref` text NOT NULL,
	`confidence` real NOT NULL,
	`visibility` text NOT NULL,
	`importance` text NOT NULL,
	`embedding` blob,
	`embedding_model` text,
	FOREIGN KEY (`relation_id`) REFERENCES `relations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `facts_series_idx` ON `facts` (`series_id`);--> statement-breakpoint
CREATE INDEX `facts_series_valid_from_idx` ON `facts` (`series_id`,`valid_from_ordinal`);--> statement-breakpoint
CREATE INDEX `facts_relation_idx` ON `facts` (`relation_id`);--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. `runs.state` held five of the pipeline's six states.
--
-- `succeeded` was stored as `done` and **`cancelled` was stored as `failed`**. The
-- second fold is recoverable and this is the only chance to recover it: the repository
-- that wrote these rows also wrote the true status into `metadata.status`, precisely so
-- that a widening migration could put it back. Run that restore first, then map any
-- remaining `done` - rows written by a seeder or a test, which never carried metadata.
--
-- A `failed` row with no `metadata.status` stays `failed`. That is the honest answer:
-- nothing in the database distinguishes it, and guessing would be worse than the gap.
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE `runs`
SET `state` = json_extract(`metadata`, '$.status')
WHERE json_valid(`metadata`)
  AND json_extract(`metadata`, '$.status') IN ('queued', 'running', 'paused', 'succeeded', 'failed', 'cancelled');
--> statement-breakpoint
UPDATE `runs` SET `state` = 'succeeded' WHERE `state` = 'done';--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. The rows every other table already pointed at.
--
-- `runs.project_id` and `episodes.series_id` have been bare columns with no referent
-- since 0000. The foreign keys onto these two tables are deliberately *not* added here:
-- existing rows name projects that only ever lived in a JSON file, and a constraint
-- added before a backfill turns a startup into `FOREIGN KEY constraint failed`.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`locale` text NOT NULL,
	`style_bible_id` text,
	`budget_nano_usd` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `projects_updated_at_idx` ON `projects` (`updated_at`);--> statement-breakpoint
CREATE TABLE `series` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`premise` text NOT NULL,
	`has_bible` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `series_project_idx` ON `series` (`project_id`);--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Render artefacts, out of `jobs.result` and into rows that can be queried.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE `render_artifacts` (
	`job_id` text NOT NULL,
	`path` text NOT NULL,
	`kind` text NOT NULL,
	`format` text,
	`sha256` text NOT NULL,
	`bytes` integer NOT NULL,
	`duration_ms` integer NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`frame_count` integer NOT NULL,
	`encode` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`job_id`, `path`),
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `render_artifacts_sha256_idx` ON `render_artifacts` (`sha256`);--> statement-breakpoint
CREATE INDEX `render_artifacts_format_idx` ON `render_artifacts` (`format`);--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Per-step resume points for S6 Produce.
--
-- No foreign key to `runs`: a produce run driven from the CLI mints a `RunId` and has
-- no `runs` row, which is how the resume demo works today. An orphaned checkpoint costs
-- a re-run and nothing else.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE `produce_checkpoints` (
	`run_id` text NOT NULL,
	`asset_key` text NOT NULL,
	`step` text NOT NULL,
	`attempt` integer NOT NULL,
	`stage` text NOT NULL,
	`input_hash` text NOT NULL,
	`outputs` text NOT NULL,
	`job_ids` text NOT NULL,
	`cost_nano_usd` integer NOT NULL,
	`completed_at` text NOT NULL,
	PRIMARY KEY(`run_id`, `asset_key`, `step`, `attempt`)
);
--> statement-breakpoint
CREATE INDEX `produce_checkpoints_run_completed_idx` ON `produce_checkpoints` (`run_id`,`completed_at`);
