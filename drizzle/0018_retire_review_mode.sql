-- Retire the reject/revert half of the General Agent write review.
--
-- Author review (approve) mode was retired on 2026-10-17: every General Agent
-- write commits directly. `agent_runtime_write_review` and its ordered
-- `agent_runtime_write_review_block` rows stay as internal settlement
-- receipts: a receipt is created once its effect is result-committed and
-- settles `pending` -> `accepted` -> `accepted_effect`; a block settles
-- `pending` -> `accepted`. The reject decision, the inverse it ran and its
-- failure states (`rejected`, `revert_started`, `reverted`, `revert_failed`,
-- `revert_unavailable`) are gone, so the columns that only recorded them are
-- dropped: the decision note, the revert effect, the error code and message,
-- `rejected_at` and `revert_started_at`.
--
-- No database ever recorded a reject decision. A database that still holds
-- one is refused instead of losing it: the guard below inserts every review or
-- block row outside the settlement states into a temporary table whose CHECK
-- rejects any row, which aborts the migration and leaves the source database
-- untouched. Only `status` is indexed and neither table has CHECKs or
-- triggers, so the columns are dropped in place.
CREATE TEMP TABLE `__review_mode_guard` (
	`status` text CHECK (`status` IS NULL)
);
--> statement-breakpoint
INSERT INTO `__review_mode_guard` (`status`)
	SELECT `status` FROM `agent_runtime_write_review`
	WHERE `status` NOT IN ('pending', 'accepted', 'accepted_effect')
	UNION ALL
	SELECT `status` FROM `agent_runtime_write_review_block`
	WHERE `status` NOT IN ('pending', 'accepted');
--> statement-breakpoint
DROP TABLE `__review_mode_guard`;
--> statement-breakpoint
ALTER TABLE `agent_runtime_write_review_block` DROP COLUMN `decision_note_json`;
--> statement-breakpoint
ALTER TABLE `agent_runtime_write_review_block` DROP COLUMN `revert_effect_json`;
--> statement-breakpoint
ALTER TABLE `agent_runtime_write_review_block` DROP COLUMN `error_code`;
--> statement-breakpoint
ALTER TABLE `agent_runtime_write_review_block` DROP COLUMN `error_message`;
--> statement-breakpoint
ALTER TABLE `agent_runtime_write_review_block` DROP COLUMN `revert_started_at`;
--> statement-breakpoint
ALTER TABLE `agent_runtime_write_review` DROP COLUMN `decision_note_json`;
--> statement-breakpoint
ALTER TABLE `agent_runtime_write_review` DROP COLUMN `revert_effect_json`;
--> statement-breakpoint
ALTER TABLE `agent_runtime_write_review` DROP COLUMN `error_code`;
--> statement-breakpoint
ALTER TABLE `agent_runtime_write_review` DROP COLUMN `error_message`;
--> statement-breakpoint
ALTER TABLE `agent_runtime_write_review` DROP COLUMN `rejected_at`;
--> statement-breakpoint
ALTER TABLE `agent_runtime_write_review` DROP COLUMN `revert_started_at`;
