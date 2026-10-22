-- Local journal truncation. A replica whose reducer base covers part of its
-- journal may delete those change-set, mutation and apply-receipt rows. The
-- floor per writer lane is recorded with the base in one transaction and the
-- delete guards below admit nothing else.
CREATE TABLE `sync_journal_truncation` (
	`sync_generation_id` text NOT NULL,
	`writer_id` text NOT NULL,
	`writer_epoch` text NOT NULL,
	`truncated_through_seq` integer NOT NULL,
	`source_checkpoint_id` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`sync_generation_id`, `writer_id`, `writer_epoch`),
	FOREIGN KEY (`sync_generation_id`) REFERENCES `sync_generation`(`sync_generation_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "sync_journal_truncation_seq_check" CHECK("sync_journal_truncation"."truncated_through_seq" >= 1)
);
--> statement-breakpoint
CREATE TRIGGER `trg_sync_journal_truncation_insert_guard`
BEFORE INSERT ON `sync_journal_truncation`
FOR EACH ROW
WHEN NOT EXISTS (
	SELECT 1 FROM `sync_reducer_base` AS `base`
	WHERE `base`.`sync_generation_id` = NEW.`sync_generation_id`
)
BEGIN
	SELECT RAISE(ABORT, 'sync journal truncation requires a reducer base');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_sync_journal_truncation_monotonic`
BEFORE UPDATE ON `sync_journal_truncation`
FOR EACH ROW
WHEN NEW.`sync_generation_id` IS NOT OLD.`sync_generation_id`
	OR NEW.`writer_id` IS NOT OLD.`writer_id`
	OR NEW.`writer_epoch` IS NOT OLD.`writer_epoch`
	OR NEW.`truncated_through_seq` < OLD.`truncated_through_seq`
	OR NOT EXISTS (
		SELECT 1 FROM `sync_reducer_base` AS `base`
		WHERE `base`.`sync_generation_id` = NEW.`sync_generation_id`
	)
BEGIN
	SELECT RAISE(ABORT, 'sync journal truncation floor cannot move backwards');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_sync_journal_truncation_no_delete`
BEFORE DELETE ON `sync_journal_truncation`
FOR EACH ROW
BEGIN
	SELECT RAISE(ABORT, 'sync journal truncation floor cannot be deleted');
END;
--> statement-breakpoint
-- An applied change-set may leave only at or below its lane's floor, while a
-- reducer base exists, and, if authored here, once its segment is published:
-- at or below the published frontier and outside any open published gap.
-- Mutations and the apply receipt are judged by their change-set row, which
-- their restrict foreign keys keep in place until they are gone.
DROP TRIGGER `trg_sync_change_set_no_delete`;
--> statement-breakpoint
CREATE TRIGGER `trg_sync_change_set_no_delete`
BEFORE DELETE ON `sync_change_set`
FOR EACH ROW
WHEN NOT (
	OLD.`apply_state` = 'applied'
	AND EXISTS (
		SELECT 1 FROM `sync_reducer_base` AS `base`
		WHERE `base`.`sync_generation_id` = OLD.`sync_generation_id`
	)
	AND EXISTS (
		SELECT 1 FROM `sync_journal_truncation` AS `floor`
		WHERE `floor`.`sync_generation_id` = OLD.`sync_generation_id`
			AND `floor`.`writer_id` = OLD.`writer_id`
			AND `floor`.`writer_epoch` = OLD.`writer_epoch`
			AND OLD.`device_seq` <= `floor`.`truncated_through_seq`
	)
	AND (
		OLD.`origin` = 'remote'
		OR (
			EXISTS (
				SELECT 1 FROM `sync_frontier` AS `frontier`
				WHERE `frontier`.`sync_generation_id` = OLD.`sync_generation_id`
					AND `frontier`.`writer_id` = OLD.`writer_id`
					AND `frontier`.`writer_epoch` = OLD.`writer_epoch`
					AND OLD.`device_seq` <= `frontier`.`published_seq`
			)
			AND NOT EXISTS (
				SELECT 1 FROM `sync_frontier_gap` AS `gap`
				WHERE `gap`.`sync_generation_id` = OLD.`sync_generation_id`
					AND `gap`.`writer_id` = OLD.`writer_id`
					AND `gap`.`writer_epoch` = OLD.`writer_epoch`
					AND `gap`.`lane` = 'published'
					AND `gap`.`state` = 'open'
					AND OLD.`device_seq` BETWEEN `gap`.`first_seq` AND `gap`.`last_seq`
			)
		)
	)
)
BEGIN
	SELECT RAISE(ABORT, 'sync change set cannot be deleted');
END;
--> statement-breakpoint
DROP TRIGGER `trg_sync_mutation_no_delete`;
--> statement-breakpoint
CREATE TRIGGER `trg_sync_mutation_no_delete`
BEFORE DELETE ON `sync_mutation`
FOR EACH ROW
WHEN NOT EXISTS (
	SELECT 1 FROM `sync_change_set` AS `change_set`
	WHERE `change_set`.`change_set_id` = OLD.`change_set_id`
		AND `change_set`.`apply_state` = 'applied'
		AND EXISTS (
			SELECT 1 FROM `sync_reducer_base` AS `base`
			WHERE `base`.`sync_generation_id` = `change_set`.`sync_generation_id`
		)
		AND EXISTS (
			SELECT 1 FROM `sync_journal_truncation` AS `floor`
			WHERE `floor`.`sync_generation_id` = `change_set`.`sync_generation_id`
				AND `floor`.`writer_id` = `change_set`.`writer_id`
				AND `floor`.`writer_epoch` = `change_set`.`writer_epoch`
				AND `change_set`.`device_seq` <= `floor`.`truncated_through_seq`
		)
		AND (
			`change_set`.`origin` = 'remote'
			OR (
				EXISTS (
					SELECT 1 FROM `sync_frontier` AS `frontier`
					WHERE `frontier`.`sync_generation_id` = `change_set`.`sync_generation_id`
						AND `frontier`.`writer_id` = `change_set`.`writer_id`
						AND `frontier`.`writer_epoch` = `change_set`.`writer_epoch`
						AND `change_set`.`device_seq` <= `frontier`.`published_seq`
				)
				AND NOT EXISTS (
					SELECT 1 FROM `sync_frontier_gap` AS `gap`
					WHERE `gap`.`sync_generation_id` = `change_set`.`sync_generation_id`
						AND `gap`.`writer_id` = `change_set`.`writer_id`
						AND `gap`.`writer_epoch` = `change_set`.`writer_epoch`
						AND `gap`.`lane` = 'published'
						AND `gap`.`state` = 'open'
						AND `change_set`.`device_seq` BETWEEN `gap`.`first_seq` AND `gap`.`last_seq`
				)
			)
		)
)
BEGIN
	SELECT RAISE(ABORT, 'sync mutation cannot be deleted');
END;
--> statement-breakpoint
DROP TRIGGER `trg_sync_apply_receipt_no_delete`;
--> statement-breakpoint
CREATE TRIGGER `trg_sync_apply_receipt_no_delete`
BEFORE DELETE ON `sync_apply_receipt`
FOR EACH ROW
WHEN NOT EXISTS (
	SELECT 1 FROM `sync_change_set` AS `change_set`
	WHERE `change_set`.`change_set_id` = OLD.`change_set_id`
		AND `change_set`.`sync_generation_id` = OLD.`sync_generation_id`
		AND `change_set`.`apply_state` = 'applied'
		AND EXISTS (
			SELECT 1 FROM `sync_reducer_base` AS `base`
			WHERE `base`.`sync_generation_id` = `change_set`.`sync_generation_id`
		)
		AND EXISTS (
			SELECT 1 FROM `sync_journal_truncation` AS `floor`
			WHERE `floor`.`sync_generation_id` = `change_set`.`sync_generation_id`
				AND `floor`.`writer_id` = `change_set`.`writer_id`
				AND `floor`.`writer_epoch` = `change_set`.`writer_epoch`
				AND `change_set`.`device_seq` <= `floor`.`truncated_through_seq`
		)
		AND (
			`change_set`.`origin` = 'remote'
			OR (
				EXISTS (
					SELECT 1 FROM `sync_frontier` AS `frontier`
					WHERE `frontier`.`sync_generation_id` = `change_set`.`sync_generation_id`
						AND `frontier`.`writer_id` = `change_set`.`writer_id`
						AND `frontier`.`writer_epoch` = `change_set`.`writer_epoch`
						AND `change_set`.`device_seq` <= `frontier`.`published_seq`
				)
				AND NOT EXISTS (
					SELECT 1 FROM `sync_frontier_gap` AS `gap`
					WHERE `gap`.`sync_generation_id` = `change_set`.`sync_generation_id`
						AND `gap`.`writer_id` = `change_set`.`writer_id`
						AND `gap`.`writer_epoch` = `change_set`.`writer_epoch`
						AND `gap`.`lane` = 'published'
						AND `gap`.`state` = 'open'
						AND `change_set`.`device_seq` BETWEEN `gap`.`first_seq` AND `gap`.`last_seq`
				)
			)
		)
)
BEGIN
	SELECT RAISE(ABORT, 'sync apply receipt cannot be deleted');
END;
--> statement-breakpoint
-- The Yjs materialization receipt outlives its source mutation as a watermark.
-- SQLite cannot drop a foreign key in place, and renaming a table breaks its
-- table-qualified CHECK constraints, so the rows are copied aside and back.
DROP TRIGGER `sync_yjs_materialization_receipt_insert_guard`;
--> statement-breakpoint
DROP TRIGGER `sync_yjs_materialization_receipt_immutable_update`;
--> statement-breakpoint
DROP TRIGGER `sync_yjs_materialization_receipt_immutable_delete`;
--> statement-breakpoint
DROP INDEX `uniq_sync_yjs_materialization_update`;
--> statement-breakpoint
CREATE TABLE `__sync_yjs_materialization_receipt_0008` AS SELECT * FROM `sync_yjs_materialization_receipt`;
--> statement-breakpoint
DROP TABLE `sync_yjs_materialization_receipt`;
--> statement-breakpoint
CREATE TABLE `sync_yjs_materialization_receipt` (
	`change_set_id` text NOT NULL,
	`mutation_index` integer NOT NULL,
	`admission_version` integer DEFAULT 1 NOT NULL,
	`original_envelope_sha256` text NOT NULL,
	`document_id` text NOT NULL,
	`incarnation` integer NOT NULL,
	`event_sha256` text NOT NULL,
	`update_row_id` integer NOT NULL,
	`document_revision` integer NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`change_set_id`, `mutation_index`),
	CONSTRAINT "sync_yjs_materialization_change_set_check" CHECK(typeof("sync_yjs_materialization_receipt"."change_set_id") = 'text' and length("sync_yjs_materialization_receipt"."change_set_id") > 0),
	CONSTRAINT "sync_yjs_materialization_index_check" CHECK(typeof("sync_yjs_materialization_receipt"."mutation_index") = 'integer' and "sync_yjs_materialization_receipt"."mutation_index" between 0 and 9007199254740991),
	CONSTRAINT "sync_yjs_materialization_version_check" CHECK(typeof("sync_yjs_materialization_receipt"."admission_version") = 'integer' and "sync_yjs_materialization_receipt"."admission_version" = 1),
	CONSTRAINT "sync_yjs_materialization_original_hash_check" CHECK(typeof("sync_yjs_materialization_receipt"."original_envelope_sha256") = 'text' and length("sync_yjs_materialization_receipt"."original_envelope_sha256") = 64 and length(CAST("sync_yjs_materialization_receipt"."original_envelope_sha256" AS BLOB)) = 64 and "sync_yjs_materialization_receipt"."original_envelope_sha256" not glob '*[^0-9a-f]*'),
	CONSTRAINT "sync_yjs_materialization_doc_check" CHECK(typeof("sync_yjs_materialization_receipt"."document_id") = 'text' and length("sync_yjs_materialization_receipt"."document_id") > 0),
	CONSTRAINT "sync_yjs_materialization_incarnation_check" CHECK(typeof("sync_yjs_materialization_receipt"."incarnation") = 'integer' and "sync_yjs_materialization_receipt"."incarnation" between 0 and 9007199254740991),
	CONSTRAINT "sync_yjs_materialization_event_hash_check" CHECK(typeof("sync_yjs_materialization_receipt"."event_sha256") = 'text' and length("sync_yjs_materialization_receipt"."event_sha256") = 64 and length(CAST("sync_yjs_materialization_receipt"."event_sha256" AS BLOB)) = 64 and "sync_yjs_materialization_receipt"."event_sha256" not glob '*[^0-9a-f]*'),
	CONSTRAINT "sync_yjs_materialization_update_check" CHECK(typeof("sync_yjs_materialization_receipt"."update_row_id") = 'integer' and "sync_yjs_materialization_receipt"."update_row_id" between 1 and 9007199254740991),
	CONSTRAINT "sync_yjs_materialization_revision_check" CHECK(typeof("sync_yjs_materialization_receipt"."document_revision") = 'integer' and "sync_yjs_materialization_receipt"."document_revision" between 1 and 9007199254740991),
	CONSTRAINT "sync_yjs_materialization_created_check" CHECK(typeof("sync_yjs_materialization_receipt"."created_at") = 'text' and length("sync_yjs_materialization_receipt"."created_at") > 0)
);
--> statement-breakpoint
INSERT INTO `sync_yjs_materialization_receipt` (
	`change_set_id`, `mutation_index`, `admission_version`, `original_envelope_sha256`, `document_id`,
	`incarnation`, `event_sha256`, `update_row_id`, `document_revision`, `created_at`
)
SELECT
	`change_set_id`, `mutation_index`, `admission_version`, `original_envelope_sha256`, `document_id`,
	`incarnation`, `event_sha256`, `update_row_id`, `document_revision`, `created_at`
FROM `__sync_yjs_materialization_receipt_0008`;
--> statement-breakpoint
DROP TABLE `__sync_yjs_materialization_receipt_0008`;
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_sync_yjs_materialization_update` ON `sync_yjs_materialization_receipt` (`update_row_id`);
--> statement-breakpoint
CREATE TRIGGER sync_yjs_materialization_receipt_insert_guard
BEFORE INSERT ON sync_yjs_materialization_receipt
BEGIN
  -- Also reject INSERT OR REPLACE without relying on recursive delete triggers.
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM sync_yjs_materialization_receipt
    WHERE (change_set_id = NEW.change_set_id AND mutation_index = NEW.mutation_index)
       OR update_row_id = NEW.update_row_id
  ) THEN RAISE(ABORT, 'Yjs materialization receipt identity already exists') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM sync_mutation m
    JOIN sync_change_set c ON c.change_set_id = m.change_set_id
    JOIN yjs_updates u ON u.id = NEW.update_row_id
    JOIN yjs_document_revision r ON r.document_id = NEW.document_id
    JOIN yjs_document_revision_provenance p
      ON p.document_id = NEW.document_id AND p.revision = NEW.document_revision
    WHERE m.change_set_id = NEW.change_set_id
      AND m.mutation_index = NEW.mutation_index
      AND m.target_family = 'yjs' AND m.target_kind = 'prose-document'
      AND m.action = 'yjs.update' AND m.payload_version = 1
      AND m.target_id = NEW.document_id AND m.incarnation = NEW.incarnation
      AND c.payload_sha256 = NEW.original_envelope_sha256
      AND u.document_id = NEW.document_id
      AND typeof(u.update_blob) = 'blob' AND length(u.update_blob) > 0
      AND r.revision >= NEW.document_revision
  ) THEN RAISE(ABORT, 'Yjs materialization receipt append identity mismatch') END;
END;
--> statement-breakpoint
CREATE TRIGGER sync_yjs_materialization_receipt_immutable_update
BEFORE UPDATE ON sync_yjs_materialization_receipt
BEGIN
  SELECT RAISE(ABORT, 'Yjs materialization receipt is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER sync_yjs_materialization_receipt_immutable_delete
BEFORE DELETE ON sync_yjs_materialization_receipt
BEGIN
  SELECT RAISE(ABORT, 'Yjs materialization receipt is immutable');
END;
--> statement-breakpoint
-- Child keys of the journal's restrict foreign keys. Every truncated mutation
-- or change-set is checked against them; without an index each check scans.
CREATE INDEX `idx_sync_conflict_change_set` ON `sync_conflict` (`change_set_id`);--> statement-breakpoint
CREATE INDEX `idx_sync_entity_lifecycle_mutation` ON `sync_entity_lifecycle` (`change_set_id`,`mutation_index`);--> statement-breakpoint
CREATE INDEX `idx_sync_field_clock_mutation` ON `sync_field_clock` (`change_set_id`,`mutation_index`);--> statement-breakpoint
CREATE INDEX `idx_sync_generation_purge_mutation` ON `sync_generation_purge` (`change_set_id`,`mutation_index`);--> statement-breakpoint
CREATE INDEX `idx_sync_order_register_mutation` ON `sync_order_register` (`change_set_id`,`mutation_index`);--> statement-breakpoint
CREATE INDEX `idx_sync_set_tag_add_mutation` ON `sync_set_tag` (`add_change_set_id`,`add_mutation_index`);--> statement-breakpoint
CREATE INDEX `idx_sync_set_tag_remove_mutation` ON `sync_set_tag` (`removed_by_change_set_id`,`removed_by_mutation_index`);
