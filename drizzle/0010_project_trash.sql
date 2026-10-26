-- Project trash: a nullable synced marker on project. Hand-written so the
-- projection update trigger can be re-created with the new column; otherwise
-- moving a project to or from the trash would not advance the workspace
-- projection journal.
ALTER TABLE `project` ADD `deleted_at` text;
--> statement-breakpoint
DROP TRIGGER workspace_projection_project_update;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_project_update AFTER UPDATE ON "project"
WHEN OLD."id" IS NOT NEW."id" OR OLD."name" IS NOT NEW."name" OR OLD."summary" IS NOT NEW."summary" OR OLD."kv_json" IS NOT NEW."kv_json" OR OLD."storyline_template_kv_json" IS NOT NEW."storyline_template_kv_json" OR OLD."user_id" IS NOT NEW."user_id" OR OLD."deleted_at" IS NOT NEW."deleted_at" OR OLD."created_at" IS NOT NEW."created_at" OR OLD."updated_at" IS NOT NEW."updated_at"
BEGIN
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = OLD.id AND (1) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = OLD.id AND (1);
  DELETE FROM workspace_projection_change WHERE project_id = OLD.id AND (1) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = OLD.id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = OLD.id AND (1) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'project', OLD.id, revision, CASE WHEN OLD.id IS NOT NEW.id THEN revision ELSE 0 END FROM workspace_projection_clock WHERE project_id = OLD.id AND (1)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = NEW.id AND (OLD.id IS NOT NEW.id) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = NEW.id AND (OLD.id IS NOT NEW.id);
  DELETE FROM workspace_projection_change WHERE project_id = NEW.id AND (OLD.id IS NOT NEW.id) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = NEW.id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = NEW.id AND (OLD.id IS NOT NEW.id) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'project', NEW.id, revision, revision FROM workspace_projection_clock WHERE project_id = NEW.id AND (OLD.id IS NOT NEW.id)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
END;
