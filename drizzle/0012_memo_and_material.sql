-- Memo: project-level note / TODO. The `resolution` column drives the UX:
--   'no_action'  — pure note (default for newly-created memos)
--   'unresolved' — author has promoted it to a TODO
--   'resolved'   — completed; moved to the collapsed archive group
-- Linkage to nodes / elements / etc. goes through `entity_reference` with
-- from_kind='memo'.
CREATE TABLE `memo` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `title` text NOT NULL DEFAULT '',
  `body_json` text NOT NULL DEFAULT '{}',
  `resolution` text NOT NULL DEFAULT 'no_action',
  `priority` text,
  `due_at` text,
  `order_key` integer NOT NULL DEFAULT 0,
  `resolved_at` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `idx_memo_project` ON `memo` (`project_id`);
--> statement-breakpoint
CREATE INDEX `idx_memo_project_resolution` ON `memo` (`project_id`, `resolution`);
--> statement-breakpoint

-- Material: project-level reference asset.
--   kind   = 'image' | 'pdf' | 'url' | 'markdown'
--   source = 'local' | 'url'
-- For markdown materials the TipTap doc lives in `body_json`. For others the
-- payload is the file/URL referenced by `uri` (and `local_path` when source=local).
CREATE TABLE `material` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `title` text NOT NULL DEFAULT '',
  `kind` text NOT NULL,
  `source` text NOT NULL DEFAULT 'local',
  `uri` text NOT NULL DEFAULT '',
  `local_path` text,
  `mime` text,
  `size_bytes` integer,
  `body_json` text,
  `notes_json` text,
  `thumbnail_uri` text,
  `order_key` integer NOT NULL DEFAULT 0,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `idx_material_project` ON `material` (`project_id`);
--> statement-breakpoint
CREATE INDEX `idx_material_project_kind` ON `material` (`project_id`, `kind`);
