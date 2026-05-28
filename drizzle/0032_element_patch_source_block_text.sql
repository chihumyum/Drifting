-- Element patch — sourceBlock snapshot.
--
-- Adds `source_block_text` to capture the plain text of the block that
-- anchored this patch at accept time. UI surfaces it when the original
-- block no longer exists in the chapter (deleted between accept and
-- viewing), so the user can still read the evidence the patch was
-- written against.
--
-- Snapshot is deliberately frozen at accept time, not re-synced from
-- the live block: the value of this column is "what the model saw when
-- it proposed the patch", which is more useful as audit context than
-- a moving copy of current prose. Existing rows are left NULL; the UI
-- treats a NULL snapshot as "no preview available".

ALTER TABLE `element_patch` ADD COLUMN `source_block_text` text;
