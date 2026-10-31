-- Retire Google Drive sync. The client no longer contains a Drive provider.
-- A library still bound to Drive becomes local exactly as a disconnect leaves
-- it: an unfinished transition is cancelled, the Drive cursors, bindings and
-- provider account are removed, and authority returns to stable local mode.
-- A Hosted library whose unfinished transition targeted Drive returns to
-- stable Hosted with its bindings kept. Projects, prose, assets, sync
-- generations and their journals are never touched; past connect attempts
-- stay as history. Drive objects this device never fetched can no longer be
-- fetched, so they are recorded as removed and their downloads cancelled, as
-- a pruning provider does; objects whose bytes are local are left alone.
-- The transition guard is lifted only for the authority update and restored
-- verbatim. The table CHECKs are left as published (a rebuild would drop the
-- sync tables' foreign keys and triggers); the triggers below refuse new
-- Drive rows instead.
UPDATE `sync_generation`
SET
  `status` = 'retired',
  `retired_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE `status` = 'staged'
  AND (
    `sync_generation_id` IN (
      SELECT `target_sync_generation_id` FROM `sync_connect_generation_attempt`
      WHERE `state` <> 'activated'
        AND `attempt_id` IN (
          SELECT `attempt_id` FROM `sync_app_authority`
          WHERE `transition_state` <> 'stable' AND 'google-drive' IN (`mode`, `target_mode`)
        )
    )
    OR (
      `project_id` IS NULL
      AND `sync_generation_id` IN (
        SELECT `source_sync_generation_id` FROM `sync_connect_generation_attempt`
        WHERE `state` <> 'activated'
          AND `attempt_id` IN (
            SELECT `attempt_id` FROM `sync_app_authority`
            WHERE `transition_state` <> 'stable' AND 'google-drive' IN (`mode`, `target_mode`)
          )
      )
    )
  );
--> statement-breakpoint
UPDATE `sync_connect_generation_attempt`
SET
  `state` = 'cancelled',
  `error_code` = NULL,
  `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE `state` <> 'activated'
  AND `attempt_id` IN (
    SELECT `attempt_id` FROM `sync_app_authority`
    WHERE `transition_state` <> 'stable' AND 'google-drive' IN (`mode`, `target_mode`)
  );
--> statement-breakpoint
UPDATE `sync_connect_attempt`
SET
  `state` = 'cancelled',
  `completed_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE `state` NOT IN ('completed', 'failed', 'cancelled')
  AND `attempt_id` IN (
    SELECT `attempt_id` FROM `sync_app_authority`
    WHERE `transition_state` <> 'stable' AND 'google-drive' IN (`mode`, `target_mode`)
  );
--> statement-breakpoint
UPDATE `sync_transfer`
SET
  `state` = 'cancelled',
  `next_attempt_at` = NULL,
  `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE `direction` = 'download'
  AND `state` IN ('pending', 'running', 'retry-wait')
  AND `remote_object_id` IN (
    SELECT `id` FROM `sync_remote_object`
    WHERE `object_kind` <> 'blob'
      AND `removed_at` IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM `sync_local_object` AS `local`
        WHERE `local`.`sync_generation_id` = `sync_remote_object`.`sync_generation_id`
          AND `local`.`logical_key_id` = `sync_remote_object`.`logical_key_id`
      )
      AND EXISTS (SELECT 1 FROM `sync_app_authority` WHERE `mode` = 'google-drive')
  );
--> statement-breakpoint
UPDATE `sync_remote_object`
SET
  `removed_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  `last_observed_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE `object_kind` <> 'blob'
  AND `removed_at` IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM `sync_local_object` AS `local`
    WHERE `local`.`sync_generation_id` = `sync_remote_object`.`sync_generation_id`
      AND `local`.`logical_key_id` = `sync_remote_object`.`logical_key_id`
  )
  AND EXISTS (SELECT 1 FROM `sync_app_authority` WHERE `mode` = 'google-drive');
--> statement-breakpoint
DELETE FROM `sync_cursor`
WHERE EXISTS (SELECT 1 FROM `sync_app_authority` WHERE `mode` = 'google-drive');
--> statement-breakpoint
DELETE FROM `sync_provider_binding`
WHERE EXISTS (SELECT 1 FROM `sync_app_authority` WHERE `mode` = 'google-drive');
--> statement-breakpoint
DELETE FROM `sync_provider_account` WHERE `provider_kind` = 'google-drive';
--> statement-breakpoint
DROP TRIGGER `trg_sync_app_authority_transition_guard`;
--> statement-breakpoint
UPDATE `sync_app_authority`
SET
  `mode` = CASE WHEN `mode` = 'google-drive' THEN 'local' ELSE `mode` END,
  `generation` = CASE WHEN `mode` = 'google-drive' THEN `generation` + 1 ELSE `generation` END,
  `transition_state` = 'stable',
  `target_mode` = NULL,
  `attempt_id` = NULL,
  `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE 'google-drive' IN (`mode`, `target_mode`);
--> statement-breakpoint
CREATE TRIGGER `trg_sync_app_authority_transition_guard`
BEFORE UPDATE ON `sync_app_authority`
FOR EACH ROW
WHEN
  NEW.`id` IS NOT OLD.`id`
  OR NEW.`generation` < OLD.`generation`
  OR (
    NEW.`mode` = OLD.`mode`
    AND NEW.`generation` <> OLD.`generation`
  )
  OR (
    NEW.`mode` <> OLD.`mode`
    AND NOT (
      OLD.`transition_state` IN ('connecting', 'switching', 'disconnecting', 'blocked')
      AND OLD.`target_mode` = NEW.`mode`
      AND OLD.`attempt_id` IS NOT NULL
      AND NEW.`transition_state` = 'stable'
      AND NEW.`target_mode` IS NULL
      AND NEW.`attempt_id` IS NULL
      AND NEW.`generation` = OLD.`generation` + 1
      AND EXISTS (
        SELECT 1
        FROM `sync_connect_attempt` AS `attempt`
        WHERE `attempt`.`attempt_id` = OLD.`attempt_id`
          AND `attempt`.`authority_generation` = OLD.`generation`
          AND `attempt`.`target_mode` = NEW.`mode`
          AND `attempt`.`state` = 'completed'
          AND `attempt`.`completed_at` IS NOT NULL
      )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid sync app authority transition');
END;
--> statement-breakpoint
CREATE TRIGGER `sync_app_authority_retired_drive_insert`
BEFORE INSERT ON `sync_app_authority`
WHEN 'google-drive' IN (NEW.`mode`, NEW.`target_mode`)
BEGIN
  SELECT RAISE(ABORT, 'Google Drive sync is retired');
END;
--> statement-breakpoint
CREATE TRIGGER `sync_app_authority_retired_drive_update`
BEFORE UPDATE OF `mode`, `target_mode` ON `sync_app_authority`
WHEN 'google-drive' IN (NEW.`mode`, NEW.`target_mode`)
BEGIN
  SELECT RAISE(ABORT, 'Google Drive sync is retired');
END;
--> statement-breakpoint
CREATE TRIGGER `sync_provider_account_retired_drive_insert`
BEFORE INSERT ON `sync_provider_account`
WHEN NEW.`provider_kind` = 'google-drive'
BEGIN
  SELECT RAISE(ABORT, 'Google Drive sync is retired');
END;
--> statement-breakpoint
CREATE TRIGGER `sync_connect_attempt_retired_drive_insert`
BEFORE INSERT ON `sync_connect_attempt`
WHEN NEW.`target_mode` = 'google-drive'
BEGIN
  SELECT RAISE(ABORT, 'Google Drive sync is retired');
END;
