-- Material provenance: a nullable, versioned origin record on library_item.
-- Hand-written instead of the generated table rebuild, which would drop every
-- trigger on library_item; the column CHECK is tested against existing rows
-- (all NULL). The projection update trigger is re-created so the new column
-- still advances the workspace projection journal.
ALTER TABLE `library_item` ADD `provenance_json` text CONSTRAINT "library_item_provenance_json_check" CHECK(`provenance_json` is null or (json_valid(`provenance_json`) and json_type(`provenance_json`, '$.v') is 'integer'));
--> statement-breakpoint
DROP TRIGGER workspace_projection_library_item_update;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_library_item_update AFTER UPDATE ON "library_item"
WHEN OLD."id" IS NOT NEW."id" OR OLD."project_id" IS NOT NEW."project_id" OR OLD."title" IS NOT NEW."title" OR OLD."kind" IS NOT NEW."kind" OR OLD."asset_id" IS NOT NEW."asset_id" OR OLD."external_url" IS NOT NEW."external_url" OR OLD."body_json" IS NOT NEW."body_json" OR OLD."notes_json" IS NOT NEW."notes_json" OR OLD."provenance_json" IS NOT NEW."provenance_json" OR OLD."preview_image_url" IS NOT NEW."preview_image_url" OR OLD."order_key" IS NOT NEW."order_key" OR OLD."created_at" IS NOT NEW."created_at" OR OLD."updated_at" IS NOT NEW."updated_at"
BEGIN
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = OLD.project_id AND (1) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = OLD.project_id AND (1);
  DELETE FROM workspace_projection_change WHERE project_id = OLD.project_id AND (1) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = OLD.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = OLD.project_id AND (1) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'library', OLD.id, revision, CASE WHEN OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id THEN revision ELSE 0 END FROM workspace_projection_clock WHERE project_id = OLD.project_id AND (1)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id);
  DELETE FROM workspace_projection_change WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = NEW.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'library', NEW.id, revision, revision FROM workspace_projection_clock WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
END;
