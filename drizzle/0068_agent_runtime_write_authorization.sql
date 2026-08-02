-- Hard pre-execution authorization for Agent writes.
--
-- Rows created before this migration may keep all four columns NULL: they are
-- pre-authorization effects. Every renderer-owned write created by the new
-- runtime records the authorization decision and the hash of the exact public
-- tool arguments before a mutation can be claimed.

ALTER TABLE `agent_runtime_write_effect`
	ADD COLUMN `authorization_kind` text;
--> statement-breakpoint
ALTER TABLE `agent_runtime_write_effect`
	ADD COLUMN `authorization_request_id` text;
--> statement-breakpoint
ALTER TABLE `agent_runtime_write_effect`
	ADD COLUMN `authorization_arguments_hash` text;
--> statement-breakpoint
ALTER TABLE `agent_runtime_write_effect`
	ADD COLUMN `authorized_at` text;
--> statement-breakpoint

CREATE TRIGGER `trg_agent_runtime_write_effect_authorization_insert`
BEFORE INSERT ON `agent_runtime_write_effect`
FOR EACH ROW
WHEN
	NOT (
		(NEW.`authorization_kind` IS NULL
			AND NEW.`authorization_request_id` IS NULL
			AND NEW.`authorization_arguments_hash` IS NULL
			AND NEW.`authorized_at` IS NULL)
		OR
		(NEW.`authorization_kind` = 'automatic'
			AND NEW.`authorization_request_id` IS NULL
			AND NEW.`authorization_arguments_hash` IS NOT NULL
			AND length(NEW.`authorization_arguments_hash`) > 0
			AND NEW.`authorized_at` IS NOT NULL
			AND length(NEW.`authorized_at`) > 0)
		OR
		(NEW.`authorization_kind` = 'author_approved'
			AND NEW.`authorization_request_id` IS NOT NULL
			AND length(NEW.`authorization_request_id`) > 0
			AND NEW.`authorization_arguments_hash` IS NOT NULL
			AND length(NEW.`authorization_arguments_hash`) > 0
			AND NEW.`authorized_at` IS NOT NULL
			AND length(NEW.`authorized_at`) > 0)
	)
BEGIN
	SELECT RAISE(ABORT, 'invalid agent write authorization');
END;
--> statement-breakpoint

CREATE TRIGGER `trg_agent_runtime_write_effect_authorization_immutable`
BEFORE UPDATE OF
	`authorization_kind`,
	`authorization_request_id`,
	`authorization_arguments_hash`,
	`authorized_at`
ON `agent_runtime_write_effect`
FOR EACH ROW
WHEN
	OLD.`authorization_kind` IS NOT NEW.`authorization_kind`
	OR OLD.`authorization_request_id` IS NOT NEW.`authorization_request_id`
	OR OLD.`authorization_arguments_hash` IS NOT NEW.`authorization_arguments_hash`
	OR OLD.`authorized_at` IS NOT NEW.`authorized_at`
BEGIN
	SELECT RAISE(ABORT, 'agent write authorization is immutable');
END;
--> statement-breakpoint

-- Retire review rows created by the superseded pre-authorization protocol.
-- These effects already changed the live document; keeping them `pending`
-- would leave controls whose canonical contract no longer matches the runtime.
-- New post-authorization prose reviews are created after this one-time migration.
-- Rejected/inverse-entered rows remain untouched so the existing crash
-- reconciler can still finish or fail them closed.
UPDATE `agent_runtime_write_review`
SET
	`status` = 'accepted_effect',
	`decision_note_json` = COALESCE(
		`decision_note_json`,
		'"Retired during hard-authorization migration"'
	),
	`accepted_at` = COALESCE(
		`accepted_at`,
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
	),
	`settled_at` = COALESCE(
		`settled_at`,
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
	),
	`updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE `status` IN ('pending', 'accepted');
