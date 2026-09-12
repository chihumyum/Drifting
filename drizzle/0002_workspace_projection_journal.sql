CREATE TABLE `workspace_projection_change` (
	`project_id` text NOT NULL,
	`collection` text NOT NULL,
	`entity_id` text NOT NULL,
	`revision` integer NOT NULL,
	`replacement_revision` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`project_id`, `collection`, `entity_id`),
	FOREIGN KEY (`project_id`) REFERENCES `workspace_projection_clock`(`project_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "workspace_projection_change_revision_positive" CHECK("workspace_projection_change"."revision" > 0),
	CONSTRAINT "workspace_projection_change_replacement_range" CHECK("workspace_projection_change"."replacement_revision" >= 0 and "workspace_projection_change"."replacement_revision" <= "workspace_projection_change"."revision")
);
--> statement-breakpoint
CREATE INDEX `idx_workspace_projection_change_revision` ON `workspace_projection_change` (`project_id`,`revision`);--> statement-breakpoint
CREATE TABLE `workspace_projection_clock` (
	`project_id` text PRIMARY KEY NOT NULL,
	`epoch` text DEFAULT (lower(hex(randomblob(16)))) NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`retained_after` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "workspace_projection_clock_range" CHECK("workspace_projection_clock"."revision" >= "workspace_projection_clock"."retained_after" and "workspace_projection_clock"."retained_after" >= 0)
);
--> statement-breakpoint
INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_project_insert AFTER INSERT ON "project"
BEGIN
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = NEW.id AND (1) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = NEW.id AND (1);
  DELETE FROM workspace_projection_change WHERE project_id = NEW.id AND (1) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = NEW.id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = NEW.id AND (1) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'project', NEW.id, revision, revision FROM workspace_projection_clock WHERE project_id = NEW.id AND (1)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
END;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_project_update AFTER UPDATE ON "project"
WHEN OLD."id" IS NOT NEW."id" OR OLD."name" IS NOT NEW."name" OR OLD."summary" IS NOT NEW."summary" OR OLD."kv_json" IS NOT NEW."kv_json" OR OLD."storyline_template_kv_json" IS NOT NEW."storyline_template_kv_json" OR OLD."user_id" IS NOT NEW."user_id" OR OLD."created_at" IS NOT NEW."created_at" OR OLD."updated_at" IS NOT NEW."updated_at"
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
--> statement-breakpoint
CREATE TRIGGER workspace_projection_project_delete AFTER DELETE ON "project"
BEGIN
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = OLD.id AND (1) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = OLD.id AND (1);
  DELETE FROM workspace_projection_change WHERE project_id = OLD.id AND (1) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = OLD.id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = OLD.id AND (1) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'project', OLD.id, revision, revision FROM workspace_projection_clock WHERE project_id = OLD.id AND (1)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
END;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_book_node_insert AFTER INSERT ON "book_node"
BEGIN
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = NEW.project_id AND (1) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = NEW.project_id AND (1);
  DELETE FROM workspace_projection_change WHERE project_id = NEW.project_id AND (1) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = NEW.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = NEW.project_id AND (1) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'nodes', NEW.id, revision, revision FROM workspace_projection_clock WHERE project_id = NEW.project_id AND (1)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
END;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_book_node_update AFTER UPDATE ON "book_node"
WHEN OLD."id" IS NOT NEW."id" OR OLD."title" IS NOT NEW."title" OR OLD."summary" IS NOT NEW."summary" OR OLD."book_order" IS NOT NEW."book_order" OR OLD."narrative_order" IS NOT NEW."narrative_order" OR OLD."project_id" IS NOT NEW."project_id" OR OLD."word_count" IS NOT NEW."word_count" OR OLD."word_count_basis_kind" IS NOT NEW."word_count_basis_kind" OR OLD."word_count_basis_hash" IS NOT NEW."word_count_basis_hash" OR OLD."word_count_basis_revision" IS NOT NEW."word_count_basis_revision" OR OLD."word_count_basis_server_seq" IS NOT NEW."word_count_basis_server_seq" OR OLD."writing_status" IS NOT NEW."writing_status" OR OLD."kind" IS NOT NEW."kind" OR OLD."drift_group_id" IS NOT NEW."drift_group_id" OR OLD."deleted_at" IS NOT NEW."deleted_at" OR OLD."created_at" IS NOT NEW."created_at" OR OLD."updated_at" IS NOT NEW."updated_at" OR OLD."position_x" IS NOT NEW."position_x" OR OLD."position_y" IS NOT NEW."position_y"
BEGIN
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = OLD.project_id AND (1) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = OLD.project_id AND (1);
  DELETE FROM workspace_projection_change WHERE project_id = OLD.project_id AND (1) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = OLD.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = OLD.project_id AND (1) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'nodes', OLD.id, revision, CASE WHEN OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id THEN revision ELSE 0 END FROM workspace_projection_clock WHERE project_id = OLD.project_id AND (1)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id);
  DELETE FROM workspace_projection_change WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = NEW.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'nodes', NEW.id, revision, revision FROM workspace_projection_clock WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
END;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_book_node_delete AFTER DELETE ON "book_node"
BEGIN
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = OLD.project_id AND (1) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = OLD.project_id AND (1);
  DELETE FROM workspace_projection_change WHERE project_id = OLD.project_id AND (1) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = OLD.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = OLD.project_id AND (1) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'nodes', OLD.id, revision, revision FROM workspace_projection_clock WHERE project_id = OLD.project_id AND (1)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
END;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_storylines_insert AFTER INSERT ON "storylines"
BEGIN
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = NEW.project_id AND (1) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = NEW.project_id AND (1);
  DELETE FROM workspace_projection_change WHERE project_id = NEW.project_id AND (1) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = NEW.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = NEW.project_id AND (1) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'storylines', NEW.id, revision, revision FROM workspace_projection_clock WHERE project_id = NEW.project_id AND (1)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
END;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_storylines_update AFTER UPDATE ON "storylines"
WHEN OLD."id" IS NOT NEW."id" OR OLD."project_id" IS NOT NEW."project_id" OR OLD."name" IS NOT NEW."name" OR OLD."color" IS NOT NEW."color" OR OLD."summary" IS NOT NEW."summary" OR OLD."order_key" IS NOT NEW."order_key" OR OLD."content_json" IS NOT NEW."content_json" OR OLD."kv_json" IS NOT NEW."kv_json" OR OLD."node_content_template_json" IS NOT NEW."node_content_template_json" OR OLD."deleted_at" IS NOT NEW."deleted_at" OR OLD."created_at" IS NOT NEW."created_at" OR OLD."updated_at" IS NOT NEW."updated_at"
BEGIN
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = OLD.project_id AND (1) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = OLD.project_id AND (1);
  DELETE FROM workspace_projection_change WHERE project_id = OLD.project_id AND (1) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = OLD.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = OLD.project_id AND (1) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'storylines', OLD.id, revision, CASE WHEN OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id THEN revision ELSE 0 END FROM workspace_projection_clock WHERE project_id = OLD.project_id AND (1)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id);
  DELETE FROM workspace_projection_change WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = NEW.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'storylines', NEW.id, revision, revision FROM workspace_projection_clock WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
END;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_storylines_delete AFTER DELETE ON "storylines"
BEGIN
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = OLD.project_id AND (1) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = OLD.project_id AND (1);
  DELETE FROM workspace_projection_change WHERE project_id = OLD.project_id AND (1) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = OLD.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = OLD.project_id AND (1) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'storylines', OLD.id, revision, revision FROM workspace_projection_clock WHERE project_id = OLD.project_id AND (1)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
END;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_element_insert AFTER INSERT ON "element"
BEGIN
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = NEW.project_id AND (1) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = NEW.project_id AND (1);
  DELETE FROM workspace_projection_change WHERE project_id = NEW.project_id AND (1) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = NEW.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = NEW.project_id AND (1) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'elements', NEW.id, revision, revision FROM workspace_projection_clock WHERE project_id = NEW.project_id AND (1)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
END;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_element_update AFTER UPDATE ON "element"
WHEN OLD."id" IS NOT NEW."id" OR OLD."project_id" IS NOT NEW."project_id" OR OLD."category_id" IS NOT NEW."category_id" OR OLD."name" IS NOT NEW."name" OR OLD."summary" IS NOT NEW."summary" OR OLD."content_json" IS NOT NEW."content_json" OR OLD."kv_json" IS NOT NEW."kv_json" OR OLD."aliases_json" IS NOT NEW."aliases_json" OR OLD."group_name" IS NOT NEW."group_name" OR OLD."portrait_asset_id" IS NOT NEW."portrait_asset_id" OR OLD."deleted_at" IS NOT NEW."deleted_at" OR OLD."created_at" IS NOT NEW."created_at" OR OLD."updated_at" IS NOT NEW."updated_at"
BEGIN
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = OLD.project_id AND (1) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = OLD.project_id AND (1);
  DELETE FROM workspace_projection_change WHERE project_id = OLD.project_id AND (1) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = OLD.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = OLD.project_id AND (1) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'elements', OLD.id, revision, CASE WHEN OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id THEN revision ELSE 0 END FROM workspace_projection_clock WHERE project_id = OLD.project_id AND (1)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id);
  DELETE FROM workspace_projection_change WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = NEW.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'elements', NEW.id, revision, revision FROM workspace_projection_clock WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
END;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_element_delete AFTER DELETE ON "element"
BEGIN
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = OLD.project_id AND (1) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = OLD.project_id AND (1);
  DELETE FROM workspace_projection_change WHERE project_id = OLD.project_id AND (1) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = OLD.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = OLD.project_id AND (1) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'elements', OLD.id, revision, revision FROM workspace_projection_clock WHERE project_id = OLD.project_id AND (1)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
END;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_element_category_insert AFTER INSERT ON "element_category"
BEGIN
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = NEW.project_id AND (1) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = NEW.project_id AND (1);
  DELETE FROM workspace_projection_change WHERE project_id = NEW.project_id AND (1) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = NEW.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = NEW.project_id AND (1) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'categories', NEW.id, revision, revision FROM workspace_projection_clock WHERE project_id = NEW.project_id AND (1)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
END;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_element_category_update AFTER UPDATE ON "element_category"
WHEN OLD."id" IS NOT NEW."id" OR OLD."name" IS NOT NEW."name" OR OLD."content_json" IS NOT NEW."content_json" OR OLD."element_template_json" IS NOT NEW."element_template_json" OR OLD."element_template_kv_json" IS NOT NEW."element_template_kv_json" OR OLD."color" IS NOT NEW."color" OR OLD."project_id" IS NOT NEW."project_id" OR OLD."layout_mode" IS NOT NEW."layout_mode" OR OLD."grid_x" IS NOT NEW."grid_x" OR OLD."grid_y" IS NOT NEW."grid_y" OR OLD."deleted_at" IS NOT NEW."deleted_at" OR OLD."created_at" IS NOT NEW."created_at" OR OLD."updated_at" IS NOT NEW."updated_at"
BEGIN
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = OLD.project_id AND (1) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = OLD.project_id AND (1);
  DELETE FROM workspace_projection_change WHERE project_id = OLD.project_id AND (1) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = OLD.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = OLD.project_id AND (1) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'categories', OLD.id, revision, CASE WHEN OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id THEN revision ELSE 0 END FROM workspace_projection_clock WHERE project_id = OLD.project_id AND (1)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id);
  DELETE FROM workspace_projection_change WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = NEW.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'categories', NEW.id, revision, revision FROM workspace_projection_clock WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
END;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_element_category_delete AFTER DELETE ON "element_category"
BEGIN
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = OLD.project_id AND (1) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = OLD.project_id AND (1);
  DELETE FROM workspace_projection_change WHERE project_id = OLD.project_id AND (1) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = OLD.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = OLD.project_id AND (1) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'categories', OLD.id, revision, revision FROM workspace_projection_clock WHERE project_id = OLD.project_id AND (1)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
END;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_project_asset_insert AFTER INSERT ON "project_asset"
BEGIN
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = NEW.project_id AND (1) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = NEW.project_id AND (1);
  DELETE FROM workspace_projection_change WHERE project_id = NEW.project_id AND (1) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = NEW.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = NEW.project_id AND (1) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'assets', NEW.id, revision, revision FROM workspace_projection_clock WHERE project_id = NEW.project_id AND (1)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
END;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_project_asset_update AFTER UPDATE ON "project_asset"
WHEN OLD."id" IS NOT NEW."id" OR OLD."project_id" IS NOT NEW."project_id" OR OLD."kind" IS NOT NEW."kind" OR OLD."source_mime" IS NOT NEW."source_mime" OR OLD."source_size_bytes" IS NOT NEW."source_size_bytes" OR OLD."source_sha256" IS NOT NEW."source_sha256" OR OLD."width" IS NOT NEW."width" OR OLD."height" IS NOT NEW."height" OR OLD."created_at" IS NOT NEW."created_at"
BEGIN
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = OLD.project_id AND (1) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = OLD.project_id AND (1);
  DELETE FROM workspace_projection_change WHERE project_id = OLD.project_id AND (1) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = OLD.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = OLD.project_id AND (1) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'assets', OLD.id, revision, CASE WHEN OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id THEN revision ELSE 0 END FROM workspace_projection_clock WHERE project_id = OLD.project_id AND (1)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id);
  DELETE FROM workspace_projection_change WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = NEW.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'assets', NEW.id, revision, revision FROM workspace_projection_clock WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
END;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_project_asset_delete AFTER DELETE ON "project_asset"
BEGIN
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = OLD.project_id AND (1) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = OLD.project_id AND (1);
  DELETE FROM workspace_projection_change WHERE project_id = OLD.project_id AND (1) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = OLD.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = OLD.project_id AND (1) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'assets', OLD.id, revision, revision FROM workspace_projection_clock WHERE project_id = OLD.project_id AND (1)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
END;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_library_item_insert AFTER INSERT ON "library_item"
BEGIN
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = NEW.project_id AND (1) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = NEW.project_id AND (1);
  DELETE FROM workspace_projection_change WHERE project_id = NEW.project_id AND (1) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = NEW.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = NEW.project_id AND (1) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'library', NEW.id, revision, revision FROM workspace_projection_clock WHERE project_id = NEW.project_id AND (1)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
END;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_library_item_update AFTER UPDATE ON "library_item"
WHEN OLD."id" IS NOT NEW."id" OR OLD."project_id" IS NOT NEW."project_id" OR OLD."title" IS NOT NEW."title" OR OLD."kind" IS NOT NEW."kind" OR OLD."asset_id" IS NOT NEW."asset_id" OR OLD."external_url" IS NOT NEW."external_url" OR OLD."body_json" IS NOT NEW."body_json" OR OLD."notes_json" IS NOT NEW."notes_json" OR OLD."preview_image_url" IS NOT NEW."preview_image_url" OR OLD."order_key" IS NOT NEW."order_key" OR OLD."created_at" IS NOT NEW."created_at" OR OLD."updated_at" IS NOT NEW."updated_at"
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
CREATE TRIGGER workspace_projection_library_item_delete AFTER DELETE ON "library_item"
BEGIN
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = OLD.project_id AND (1) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = OLD.project_id AND (1);
  DELETE FROM workspace_projection_change WHERE project_id = OLD.project_id AND (1) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = OLD.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = OLD.project_id AND (1) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'library', OLD.id, revision, revision FROM workspace_projection_clock WHERE project_id = OLD.project_id AND (1)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
END;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_comment_insert AFTER INSERT ON "comment"
BEGIN
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = NEW.project_id AND (1) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = NEW.project_id AND (1);
  DELETE FROM workspace_projection_change WHERE project_id = NEW.project_id AND (1) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = NEW.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = NEW.project_id AND (1) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'comments', NEW.id, revision, revision FROM workspace_projection_clock WHERE project_id = NEW.project_id AND (1)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
END;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_comment_update AFTER UPDATE ON "comment"
WHEN OLD."id" IS NOT NEW."id" OR OLD."project_id" IS NOT NEW."project_id" OR OLD."kind" IS NOT NEW."kind" OR OLD."target_kind" IS NOT NEW."target_kind" OR OLD."target_id" IS NOT NEW."target_id" OR OLD."target_block_id" IS NOT NEW."target_block_id" OR OLD."anchor_json" IS NOT NEW."anchor_json" OR OLD."author_kind" IS NOT NEW."author_kind" OR OLD."author_id" IS NOT NEW."author_id" OR OLD."author_name" IS NOT NEW."author_name" OR OLD."body_json" IS NOT NEW."body_json" OR OLD."status" IS NOT NEW."status" OR OLD."priority" IS NOT NEW."priority" OR OLD."source" IS NOT NEW."source" OR OLD."metadata_json" IS NOT NEW."metadata_json" OR OLD."target_block_ids_json" IS NOT NEW."target_block_ids_json" OR OLD."resolved_at" IS NOT NEW."resolved_at" OR OLD."created_at" IS NOT NEW."created_at" OR OLD."updated_at" IS NOT NEW."updated_at"
BEGIN
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = OLD.project_id AND (1) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = OLD.project_id AND (1);
  DELETE FROM workspace_projection_change WHERE project_id = OLD.project_id AND (1) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = OLD.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = OLD.project_id AND (1) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'comments', OLD.id, revision, CASE WHEN OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id THEN revision ELSE 0 END FROM workspace_projection_clock WHERE project_id = OLD.project_id AND (1)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id);
  DELETE FROM workspace_projection_change WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = NEW.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'comments', NEW.id, revision, revision FROM workspace_projection_clock WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
END;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_comment_delete AFTER DELETE ON "comment"
BEGIN
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = OLD.project_id AND (1) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = OLD.project_id AND (1);
  DELETE FROM workspace_projection_change WHERE project_id = OLD.project_id AND (1) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = OLD.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = OLD.project_id AND (1) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'comments', OLD.id, revision, revision FROM workspace_projection_clock WHERE project_id = OLD.project_id AND (1)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
END;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_comment_action_insert AFTER INSERT ON "comment_action"
BEGIN
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = NEW.project_id AND (1) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = NEW.project_id AND (1);
  DELETE FROM workspace_projection_change WHERE project_id = NEW.project_id AND (1) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = NEW.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = NEW.project_id AND (1) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'comment-actions', NEW.id, revision, revision FROM workspace_projection_clock WHERE project_id = NEW.project_id AND (1)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
END;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_comment_action_update AFTER UPDATE ON "comment_action"
WHEN OLD."id" IS NOT NEW."id" OR OLD."project_id" IS NOT NEW."project_id" OR OLD."comment_id" IS NOT NEW."comment_id" OR OLD."kind" IS NOT NEW."kind" OR OLD."label" IS NOT NEW."label" OR OLD."payload_json" IS NOT NEW."payload_json" OR OLD."status" IS NOT NEW."status" OR OLD."result_json" IS NOT NEW."result_json" OR OLD."created_by_kind" IS NOT NEW."created_by_kind" OR OLD."created_by_id" IS NOT NEW."created_by_id" OR OLD."created_at" IS NOT NEW."created_at" OR OLD."updated_at" IS NOT NEW."updated_at" OR OLD."applied_at" IS NOT NEW."applied_at"
BEGIN
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = OLD.project_id AND (1) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = OLD.project_id AND (1);
  DELETE FROM workspace_projection_change WHERE project_id = OLD.project_id AND (1) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = OLD.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = OLD.project_id AND (1) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'comment-actions', OLD.id, revision, CASE WHEN OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id THEN revision ELSE 0 END FROM workspace_projection_clock WHERE project_id = OLD.project_id AND (1)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id);
  DELETE FROM workspace_projection_change WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = NEW.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'comment-actions', NEW.id, revision, revision FROM workspace_projection_clock WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
END;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_comment_action_delete AFTER DELETE ON "comment_action"
BEGIN
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = OLD.project_id AND (1) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = OLD.project_id AND (1);
  DELETE FROM workspace_projection_change WHERE project_id = OLD.project_id AND (1) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = OLD.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = OLD.project_id AND (1) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'comment-actions', OLD.id, revision, revision FROM workspace_projection_clock WHERE project_id = OLD.project_id AND (1)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
END;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_entity_relation_insert AFTER INSERT ON "entity_relation"
BEGIN
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = NEW.project_id AND (1) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = NEW.project_id AND (1);
  DELETE FROM workspace_projection_change WHERE project_id = NEW.project_id AND (1) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = NEW.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = NEW.project_id AND (1) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'relations', NEW.id, revision, revision FROM workspace_projection_clock WHERE project_id = NEW.project_id AND (1)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
END;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_entity_relation_update AFTER UPDATE ON "entity_relation"
WHEN OLD."id" IS NOT NEW."id" OR OLD."project_id" IS NOT NEW."project_id" OR OLD."from_kind" IS NOT NEW."from_kind" OR OLD."from_id" IS NOT NEW."from_id" OR OLD."to_kind" IS NOT NEW."to_kind" OR OLD."to_id" IS NOT NEW."to_id" OR OLD."relation_type_id" IS NOT NEW."relation_type_id" OR OLD."created_at" IS NOT NEW."created_at" OR OLD."updated_at" IS NOT NEW."updated_at"
BEGIN
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = OLD.project_id AND (1) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = OLD.project_id AND (1);
  DELETE FROM workspace_projection_change WHERE project_id = OLD.project_id AND (1) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = OLD.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = OLD.project_id AND (1) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'relations', OLD.id, revision, CASE WHEN OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id THEN revision ELSE 0 END FROM workspace_projection_clock WHERE project_id = OLD.project_id AND (1)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id);
  DELETE FROM workspace_projection_change WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = NEW.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'relations', NEW.id, revision, revision FROM workspace_projection_clock WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
END;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_entity_relation_delete AFTER DELETE ON "entity_relation"
BEGIN
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = OLD.project_id AND (1) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = OLD.project_id AND (1);
  DELETE FROM workspace_projection_change WHERE project_id = OLD.project_id AND (1) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = OLD.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = OLD.project_id AND (1) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'relations', OLD.id, revision, revision FROM workspace_projection_clock WHERE project_id = OLD.project_id AND (1)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
END;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_entity_relation_type_insert AFTER INSERT ON "entity_relation_type"
BEGIN
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = NEW.project_id AND (1) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = NEW.project_id AND (1);
  DELETE FROM workspace_projection_change WHERE project_id = NEW.project_id AND (1) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = NEW.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = NEW.project_id AND (1) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'relation-types', NEW.id, revision, revision FROM workspace_projection_clock WHERE project_id = NEW.project_id AND (1)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
END;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_entity_relation_type_update AFTER UPDATE ON "entity_relation_type"
WHEN OLD."id" IS NOT NEW."id" OR OLD."project_id" IS NOT NEW."project_id" OR OLD."name" IS NOT NEW."name" OR OLD."normalized_name" IS NOT NEW."normalized_name" OR OLD."description" IS NOT NEW."description" OR OLD."orientation" IS NOT NEW."orientation" OR OLD."system_key" IS NOT NEW."system_key" OR OLD."locked" IS NOT NEW."locked" OR OLD."source_role" IS NOT NEW."source_role" OR OLD."target_role" IS NOT NEW."target_role" OR OLD."created_at" IS NOT NEW."created_at" OR OLD."updated_at" IS NOT NEW."updated_at"
BEGIN
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = OLD.project_id AND (1) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = OLD.project_id AND (1);
  DELETE FROM workspace_projection_change WHERE project_id = OLD.project_id AND (1) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = OLD.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = OLD.project_id AND (1) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'relation-types', OLD.id, revision, CASE WHEN OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id THEN revision ELSE 0 END FROM workspace_projection_clock WHERE project_id = OLD.project_id AND (1)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id);
  DELETE FROM workspace_projection_change WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = NEW.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'relation-types', NEW.id, revision, revision FROM workspace_projection_clock WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
END;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_entity_relation_type_delete AFTER DELETE ON "entity_relation_type"
BEGIN
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = OLD.project_id AND (1) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = OLD.project_id AND (1);
  DELETE FROM workspace_projection_change WHERE project_id = OLD.project_id AND (1) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = OLD.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = OLD.project_id AND (1) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'relation-types', OLD.id, revision, revision FROM workspace_projection_clock WHERE project_id = OLD.project_id AND (1)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
END;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_entity_relation_type_endpoint_kind_insert AFTER INSERT ON "entity_relation_type_endpoint_kind"
BEGIN
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = (SELECT project_id FROM entity_relation_type WHERE id = NEW.relation_type_id) AND (1) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = (SELECT project_id FROM entity_relation_type WHERE id = NEW.relation_type_id) AND (1);
  DELETE FROM workspace_projection_change WHERE project_id = (SELECT project_id FROM entity_relation_type WHERE id = NEW.relation_type_id) AND (1) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = (SELECT project_id FROM entity_relation_type WHERE id = NEW.relation_type_id)) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = (SELECT project_id FROM entity_relation_type WHERE id = NEW.relation_type_id) AND (1) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'relation-types', NEW.relation_type_id, revision, revision FROM workspace_projection_clock WHERE project_id = (SELECT project_id FROM entity_relation_type WHERE id = NEW.relation_type_id) AND (1)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
END;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_entity_relation_type_endpoint_kind_update AFTER UPDATE ON "entity_relation_type_endpoint_kind"
WHEN OLD."relation_type_id" IS NOT NEW."relation_type_id" OR OLD."side" IS NOT NEW."side" OR OLD."entity_kind" IS NOT NEW."entity_kind"
BEGIN
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = (SELECT project_id FROM entity_relation_type WHERE id = OLD.relation_type_id) AND (1) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = (SELECT project_id FROM entity_relation_type WHERE id = OLD.relation_type_id) AND (1);
  DELETE FROM workspace_projection_change WHERE project_id = (SELECT project_id FROM entity_relation_type WHERE id = OLD.relation_type_id) AND (1) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = (SELECT project_id FROM entity_relation_type WHERE id = OLD.relation_type_id)) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = (SELECT project_id FROM entity_relation_type WHERE id = OLD.relation_type_id) AND (1) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'relation-types', OLD.relation_type_id, revision, CASE WHEN (SELECT project_id FROM entity_relation_type WHERE id = OLD.relation_type_id) IS NOT (SELECT project_id FROM entity_relation_type WHERE id = NEW.relation_type_id) OR OLD.relation_type_id IS NOT NEW.relation_type_id THEN revision ELSE 0 END FROM workspace_projection_clock WHERE project_id = (SELECT project_id FROM entity_relation_type WHERE id = OLD.relation_type_id) AND (1)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = (SELECT project_id FROM entity_relation_type WHERE id = NEW.relation_type_id) AND ((SELECT project_id FROM entity_relation_type WHERE id = OLD.relation_type_id) IS NOT (SELECT project_id FROM entity_relation_type WHERE id = NEW.relation_type_id) OR OLD.relation_type_id IS NOT NEW.relation_type_id) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = (SELECT project_id FROM entity_relation_type WHERE id = NEW.relation_type_id) AND ((SELECT project_id FROM entity_relation_type WHERE id = OLD.relation_type_id) IS NOT (SELECT project_id FROM entity_relation_type WHERE id = NEW.relation_type_id) OR OLD.relation_type_id IS NOT NEW.relation_type_id);
  DELETE FROM workspace_projection_change WHERE project_id = (SELECT project_id FROM entity_relation_type WHERE id = NEW.relation_type_id) AND ((SELECT project_id FROM entity_relation_type WHERE id = OLD.relation_type_id) IS NOT (SELECT project_id FROM entity_relation_type WHERE id = NEW.relation_type_id) OR OLD.relation_type_id IS NOT NEW.relation_type_id) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = (SELECT project_id FROM entity_relation_type WHERE id = NEW.relation_type_id)) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = (SELECT project_id FROM entity_relation_type WHERE id = NEW.relation_type_id) AND ((SELECT project_id FROM entity_relation_type WHERE id = OLD.relation_type_id) IS NOT (SELECT project_id FROM entity_relation_type WHERE id = NEW.relation_type_id) OR OLD.relation_type_id IS NOT NEW.relation_type_id) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'relation-types', NEW.relation_type_id, revision, revision FROM workspace_projection_clock WHERE project_id = (SELECT project_id FROM entity_relation_type WHERE id = NEW.relation_type_id) AND ((SELECT project_id FROM entity_relation_type WHERE id = OLD.relation_type_id) IS NOT (SELECT project_id FROM entity_relation_type WHERE id = NEW.relation_type_id) OR OLD.relation_type_id IS NOT NEW.relation_type_id)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
END;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_entity_relation_type_endpoint_kind_delete AFTER DELETE ON "entity_relation_type_endpoint_kind"
BEGIN
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = (SELECT project_id FROM entity_relation_type WHERE id = OLD.relation_type_id) AND (1) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = (SELECT project_id FROM entity_relation_type WHERE id = OLD.relation_type_id) AND (1);
  DELETE FROM workspace_projection_change WHERE project_id = (SELECT project_id FROM entity_relation_type WHERE id = OLD.relation_type_id) AND (1) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = (SELECT project_id FROM entity_relation_type WHERE id = OLD.relation_type_id)) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = (SELECT project_id FROM entity_relation_type WHERE id = OLD.relation_type_id) AND (1) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'relation-types', OLD.relation_type_id, revision, revision FROM workspace_projection_clock WHERE project_id = (SELECT project_id FROM entity_relation_type WHERE id = OLD.relation_type_id) AND (1)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
END;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_block_section_insert AFTER INSERT ON "block_section"
BEGIN
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = NEW.project_id AND (1) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = NEW.project_id AND (1);
  DELETE FROM workspace_projection_change WHERE project_id = NEW.project_id AND (1) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = NEW.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = NEW.project_id AND (1) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'sections', NEW.id, revision, revision FROM workspace_projection_clock WHERE project_id = NEW.project_id AND (1)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
END;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_block_section_update AFTER UPDATE ON "block_section"
WHEN OLD."id" IS NOT NEW."id" OR OLD."project_id" IS NOT NEW."project_id" OR OLD."chapter_id" IS NOT NEW."chapter_id" OR OLD."block_ids_json" IS NOT NEW."block_ids_json" OR OLD."block_hashes_json" IS NOT NEW."block_hashes_json" OR OLD."summary" IS NOT NEW."summary" OR OLD."source" IS NOT NEW."source" OR OLD."created_at" IS NOT NEW."created_at" OR OLD."updated_at" IS NOT NEW."updated_at"
BEGIN
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = OLD.project_id AND (1) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = OLD.project_id AND (1);
  DELETE FROM workspace_projection_change WHERE project_id = OLD.project_id AND (1) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = OLD.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = OLD.project_id AND (1) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'sections', OLD.id, revision, CASE WHEN OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id THEN revision ELSE 0 END FROM workspace_projection_clock WHERE project_id = OLD.project_id AND (1)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id);
  DELETE FROM workspace_projection_change WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = NEW.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'sections', NEW.id, revision, revision FROM workspace_projection_clock WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
END;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_block_section_delete AFTER DELETE ON "block_section"
BEGIN
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = OLD.project_id AND (1) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = OLD.project_id AND (1);
  DELETE FROM workspace_projection_change WHERE project_id = OLD.project_id AND (1) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = OLD.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = OLD.project_id AND (1) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'sections', OLD.id, revision, revision FROM workspace_projection_clock WHERE project_id = OLD.project_id AND (1)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
END;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_book_act_insert AFTER INSERT ON "book_act"
BEGIN
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = NEW.project_id AND (1) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = NEW.project_id AND (1);
  DELETE FROM workspace_projection_change WHERE project_id = NEW.project_id AND (1) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = NEW.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = NEW.project_id AND (1) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'acts', NEW.id, revision, revision FROM workspace_projection_clock WHERE project_id = NEW.project_id AND (1)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
END;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_book_act_update AFTER UPDATE ON "book_act"
WHEN OLD."id" IS NOT NEW."id" OR OLD."project_id" IS NOT NEW."project_id" OR OLD."name" IS NOT NEW."name" OR OLD."color" IS NOT NEW."color" OR OLD."start_order" IS NOT NEW."start_order" OR OLD."drift_node_id" IS NOT NEW."drift_node_id" OR OLD."created_at" IS NOT NEW."created_at" OR OLD."updated_at" IS NOT NEW."updated_at"
BEGIN
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = OLD.project_id AND (1) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = OLD.project_id AND (1);
  DELETE FROM workspace_projection_change WHERE project_id = OLD.project_id AND (1) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = OLD.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = OLD.project_id AND (1) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'acts', OLD.id, revision, CASE WHEN OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id THEN revision ELSE 0 END FROM workspace_projection_clock WHERE project_id = OLD.project_id AND (1)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id);
  DELETE FROM workspace_projection_change WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = NEW.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'acts', NEW.id, revision, revision FROM workspace_projection_clock WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
END;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_book_act_delete AFTER DELETE ON "book_act"
BEGIN
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = OLD.project_id AND (1) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = OLD.project_id AND (1);
  DELETE FROM workspace_projection_change WHERE project_id = OLD.project_id AND (1) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = OLD.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = OLD.project_id AND (1) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'acts', OLD.id, revision, revision FROM workspace_projection_clock WHERE project_id = OLD.project_id AND (1)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
END;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_drift_group_insert AFTER INSERT ON "drift_group"
BEGIN
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = NEW.project_id AND (1) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = NEW.project_id AND (1);
  DELETE FROM workspace_projection_change WHERE project_id = NEW.project_id AND (1) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = NEW.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = NEW.project_id AND (1) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'drift-groups', NEW.id, revision, revision FROM workspace_projection_clock WHERE project_id = NEW.project_id AND (1)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
END;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_drift_group_update AFTER UPDATE ON "drift_group"
WHEN OLD."id" IS NOT NEW."id" OR OLD."project_id" IS NOT NEW."project_id" OR OLD."name" IS NOT NEW."name" OR OLD."parent_group_id" IS NOT NEW."parent_group_id" OR OLD."color" IS NOT NEW."color" OR OLD."sort_order" IS NOT NEW."sort_order" OR OLD."created_at" IS NOT NEW."created_at" OR OLD."updated_at" IS NOT NEW."updated_at"
BEGIN
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = OLD.project_id AND (1) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = OLD.project_id AND (1);
  DELETE FROM workspace_projection_change WHERE project_id = OLD.project_id AND (1) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = OLD.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = OLD.project_id AND (1) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'drift-groups', OLD.id, revision, CASE WHEN OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id THEN revision ELSE 0 END FROM workspace_projection_clock WHERE project_id = OLD.project_id AND (1)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id);
  DELETE FROM workspace_projection_change WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = NEW.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'drift-groups', NEW.id, revision, revision FROM workspace_projection_clock WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
END;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_drift_group_delete AFTER DELETE ON "drift_group"
BEGIN
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = OLD.project_id AND (1) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = OLD.project_id AND (1);
  DELETE FROM workspace_projection_change WHERE project_id = OLD.project_id AND (1) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = OLD.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = OLD.project_id AND (1) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'drift-groups', OLD.id, revision, revision FROM workspace_projection_clock WHERE project_id = OLD.project_id AND (1)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
END;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_timeline_marker_insert AFTER INSERT ON "timeline_marker"
BEGIN
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = NEW.project_id AND (1) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = NEW.project_id AND (1);
  DELETE FROM workspace_projection_change WHERE project_id = NEW.project_id AND (1) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = NEW.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = NEW.project_id AND (1) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'markers', NEW.id, revision, revision FROM workspace_projection_clock WHERE project_id = NEW.project_id AND (1)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
END;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_timeline_marker_update AFTER UPDATE ON "timeline_marker"
WHEN OLD."id" IS NOT NEW."id" OR OLD."project_id" IS NOT NEW."project_id" OR OLD."narrative_order" IS NOT NEW."narrative_order" OR OLD."label" IS NOT NEW."label" OR OLD."drift_node_id" IS NOT NEW."drift_node_id" OR OLD."created_at" IS NOT NEW."created_at" OR OLD."updated_at" IS NOT NEW."updated_at"
BEGIN
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = OLD.project_id AND (1) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = OLD.project_id AND (1);
  DELETE FROM workspace_projection_change WHERE project_id = OLD.project_id AND (1) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = OLD.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = OLD.project_id AND (1) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'markers', OLD.id, revision, CASE WHEN OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id THEN revision ELSE 0 END FROM workspace_projection_clock WHERE project_id = OLD.project_id AND (1)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id);
  DELETE FROM workspace_projection_change WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = NEW.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'markers', NEW.id, revision, revision FROM workspace_projection_clock WHERE project_id = NEW.project_id AND (OLD.project_id IS NOT NEW.project_id OR OLD.id IS NOT NEW.id)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
END;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_timeline_marker_delete AFTER DELETE ON "timeline_marker"
BEGIN
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = OLD.project_id AND (1) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = OLD.project_id AND (1);
  DELETE FROM workspace_projection_change WHERE project_id = OLD.project_id AND (1) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = OLD.project_id) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = OLD.project_id AND (1) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'markers', OLD.id, revision, revision FROM workspace_projection_clock WHERE project_id = OLD.project_id AND (1)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
END;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_node_storyline_link_insert AFTER INSERT ON "node_storyline_link"
BEGIN
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = (SELECT project_id FROM book_node WHERE id = NEW.node_id) AND (1) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = (SELECT project_id FROM book_node WHERE id = NEW.node_id) AND (1);
  DELETE FROM workspace_projection_change WHERE project_id = (SELECT project_id FROM book_node WHERE id = NEW.node_id) AND (1) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = (SELECT project_id FROM book_node WHERE id = NEW.node_id)) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = (SELECT project_id FROM book_node WHERE id = NEW.node_id) AND (1) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'memberships', NEW.node_id, revision, revision FROM workspace_projection_clock WHERE project_id = (SELECT project_id FROM book_node WHERE id = NEW.node_id) AND (1)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
END;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_node_storyline_link_update AFTER UPDATE ON "node_storyline_link"
WHEN OLD."node_id" IS NOT NEW."node_id" OR OLD."storyline_id" IS NOT NEW."storyline_id" OR OLD."is_primary" IS NOT NEW."is_primary"
BEGIN
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = (SELECT project_id FROM book_node WHERE id = OLD.node_id) AND (1) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = (SELECT project_id FROM book_node WHERE id = OLD.node_id) AND (1);
  DELETE FROM workspace_projection_change WHERE project_id = (SELECT project_id FROM book_node WHERE id = OLD.node_id) AND (1) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = (SELECT project_id FROM book_node WHERE id = OLD.node_id)) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = (SELECT project_id FROM book_node WHERE id = OLD.node_id) AND (1) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'memberships', OLD.node_id, revision, CASE WHEN (SELECT project_id FROM book_node WHERE id = OLD.node_id) IS NOT (SELECT project_id FROM book_node WHERE id = NEW.node_id) OR OLD.node_id IS NOT NEW.node_id THEN revision ELSE 0 END FROM workspace_projection_clock WHERE project_id = (SELECT project_id FROM book_node WHERE id = OLD.node_id) AND (1)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = (SELECT project_id FROM book_node WHERE id = NEW.node_id) AND ((SELECT project_id FROM book_node WHERE id = OLD.node_id) IS NOT (SELECT project_id FROM book_node WHERE id = NEW.node_id) OR OLD.node_id IS NOT NEW.node_id) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = (SELECT project_id FROM book_node WHERE id = NEW.node_id) AND ((SELECT project_id FROM book_node WHERE id = OLD.node_id) IS NOT (SELECT project_id FROM book_node WHERE id = NEW.node_id) OR OLD.node_id IS NOT NEW.node_id);
  DELETE FROM workspace_projection_change WHERE project_id = (SELECT project_id FROM book_node WHERE id = NEW.node_id) AND ((SELECT project_id FROM book_node WHERE id = OLD.node_id) IS NOT (SELECT project_id FROM book_node WHERE id = NEW.node_id) OR OLD.node_id IS NOT NEW.node_id) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = (SELECT project_id FROM book_node WHERE id = NEW.node_id)) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = (SELECT project_id FROM book_node WHERE id = NEW.node_id) AND ((SELECT project_id FROM book_node WHERE id = OLD.node_id) IS NOT (SELECT project_id FROM book_node WHERE id = NEW.node_id) OR OLD.node_id IS NOT NEW.node_id) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'memberships', NEW.node_id, revision, revision FROM workspace_projection_clock WHERE project_id = (SELECT project_id FROM book_node WHERE id = NEW.node_id) AND ((SELECT project_id FROM book_node WHERE id = OLD.node_id) IS NOT (SELECT project_id FROM book_node WHERE id = NEW.node_id) OR OLD.node_id IS NOT NEW.node_id)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
END;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_node_storyline_link_delete AFTER DELETE ON "node_storyline_link"
BEGIN
  INSERT INTO workspace_projection_clock(project_id) SELECT id FROM project WHERE id = (SELECT project_id FROM book_node WHERE id = OLD.node_id) AND (1) ON CONFLICT(project_id) DO NOTHING;
  UPDATE workspace_projection_clock SET revision = revision + 1 WHERE project_id = (SELECT project_id FROM book_node WHERE id = OLD.node_id) AND (1);
  DELETE FROM workspace_projection_change WHERE project_id = (SELECT project_id FROM book_node WHERE id = OLD.node_id) AND (1) AND (SELECT revision - retained_after FROM workspace_projection_clock WHERE project_id = (SELECT project_id FROM book_node WHERE id = OLD.node_id)) > 4096;
  UPDATE workspace_projection_clock SET retained_after = revision - 1 WHERE project_id = (SELECT project_id FROM book_node WHERE id = OLD.node_id) AND (1) AND revision - retained_after > 4096;
  INSERT INTO workspace_projection_change(project_id, collection, entity_id, revision, replacement_revision)
    SELECT project_id, 'memberships', OLD.node_id, revision, revision FROM workspace_projection_clock WHERE project_id = (SELECT project_id FROM book_node WHERE id = OLD.node_id) AND (1)
    ON CONFLICT(project_id, collection, entity_id) DO UPDATE SET revision = excluded.revision, replacement_revision = max(workspace_projection_change.replacement_revision, excluded.replacement_revision);
END;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_sync_generation_insert AFTER INSERT ON sync_generation
BEGIN
  DELETE FROM workspace_projection_change WHERE project_id = NEW.project_id;
  UPDATE workspace_projection_clock SET epoch = lower(hex(randomblob(16))), retained_after = revision WHERE project_id = NEW.project_id;
END;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_sync_generation_update AFTER UPDATE ON sync_generation
WHEN OLD."sync_generation_id" IS NOT NEW."sync_generation_id" OR OLD."project_id" IS NOT NEW."project_id" OR OLD."project_sync_id" IS NOT NEW."project_sync_id" OR OLD."generation_number" IS NOT NEW."generation_number" OR OLD."protocol_version" IS NOT NEW."protocol_version" OR OLD."domain_schema_version" IS NOT NEW."domain_schema_version" OR OLD."status" IS NOT NEW."status" OR OLD."created_at" IS NOT NEW."created_at" OR OLD."updated_at" IS NOT NEW."updated_at" OR OLD."retired_at" IS NOT NEW."retired_at" OR OLD."purged_at" IS NOT NEW."purged_at"
BEGIN
  DELETE FROM workspace_projection_change WHERE project_id = OLD.project_id OR project_id = NEW.project_id;
  UPDATE workspace_projection_clock SET epoch = lower(hex(randomblob(16))), retained_after = revision WHERE project_id = OLD.project_id OR project_id = NEW.project_id;
END;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_sync_generation_delete AFTER DELETE ON sync_generation
BEGIN
  DELETE FROM workspace_projection_change WHERE project_id = OLD.project_id;
  UPDATE workspace_projection_clock SET epoch = lower(hex(randomblob(16))), retained_after = revision WHERE project_id = OLD.project_id;
END;
