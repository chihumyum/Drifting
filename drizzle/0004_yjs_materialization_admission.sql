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
	FOREIGN KEY (`change_set_id`,`mutation_index`) REFERENCES `sync_mutation`(`change_set_id`,`mutation_index`) ON UPDATE no action ON DELETE restrict,
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

