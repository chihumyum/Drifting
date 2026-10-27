-- Material folders and the per-note TODO switch (docs/material-workbench.md).
-- Additive only: a new folder table, a nullable library_item.folder_id (every
-- existing material stays at the root) and library_item.task_todos, on by
-- default so existing notes project their checklist items as TODOs.
-- The library_item projection update trigger is re-created so the two new
-- columns still advance the workspace projection journal (as 0009 did), and
-- material_folder gets the same projection triggers as drift_group.
CREATE TABLE `material_folder` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`parent_folder_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_material_folder_project` ON `material_folder` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_material_folder_parent` ON `material_folder` (`parent_folder_id`);--> statement-breakpoint
ALTER TABLE `library_item` ADD `folder_id` text;--> statement-breakpoint
ALTER TABLE `library_item` ADD `task_todos` integer DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_library_item_folder` ON `library_item` (`folder_id`);--> statement-breakpoint
DROP TRIGGER workspace_projection_library_item_update;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_library_item_update AFTER UPDATE ON "library_item"
WHEN OLD."id" IS NOT NEW."id" OR OLD."project_id" IS NOT NEW."project_id" OR OLD."title" IS NOT NEW."title" OR OLD."kind" IS NOT NEW."kind" OR OLD."asset_id" IS NOT NEW."asset_id" OR OLD."external_url" IS NOT NEW."external_url" OR OLD."body_json" IS NOT NEW."body_json" OR OLD."notes_json" IS NOT NEW."notes_json" OR OLD."provenance_json" IS NOT NEW."provenance_json" OR OLD."preview_image_url" IS NOT NEW."preview_image_url" OR OLD."order_key" IS NOT NEW."order_key" OR OLD."folder_id" IS NOT NEW."folder_id" OR OLD."task_todos" IS NOT NEW."task_todos" OR OLD."created_at" IS NOT NEW."created_at" OR OLD."updated_at" IS NOT NEW."updated_at"
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
--> statement-breakpoint
CREATE TRIGGER workspace_projection_material_folder_insert AFTER INSERT ON "material_folder"
BEGIN
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = NEW.project_id AND (1) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = NEW.project_id AND (1);
  DELETE FROM workspace_projection_change WHERE project_id = NEW.project_id AND (1) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = NEW.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = NEW.project_id AND (1) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'material-folders', NEW.id, revision, revision FROM workspace_projection_clock WHERE project_id = NEW.project_id AND (1)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
END;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_material_folder_update AFTER UPDATE ON "material_folder"
WHEN OLD."id" IS NOT NEW."id" OR OLD."project_id" IS NOT NEW."project_id" OR OLD."name" IS NOT NEW."name" OR OLD."parent_folder_id" IS NOT NEW."parent_folder_id" OR OLD."created_at" IS NOT NEW."created_at" OR OLD."updated_at" IS NOT NEW."updated_at"
BEGIN
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = OLD.project_id AND (1) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = OLD.project_id AND (1);
  DELETE FROM workspace_projection_change WHERE project_id = OLD.project_id AND (1) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = OLD.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = OLD.project_id AND (1) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'material-folders', OLD.id, revision, CASE WHEN OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id THEN revision ELSE 0 END FROM workspace_projection_clock WHERE project_id = OLD.project_id AND (1)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id);
  DELETE FROM workspace_projection_change WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = NEW.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'material-folders', NEW.id, revision, revision FROM workspace_projection_clock WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
END;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_material_folder_delete AFTER DELETE ON "material_folder"
BEGIN
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = OLD.project_id AND (1) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = OLD.project_id AND (1);
  DELETE FROM workspace_projection_change WHERE project_id = OLD.project_id AND (1) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = OLD.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = OLD.project_id AND (1) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'material-folders', OLD.id, revision, revision FROM workspace_projection_clock WHERE project_id = OLD.project_id AND (1)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
END;
