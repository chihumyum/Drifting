-- Retire url materials (docs/material-workbench.md, M1).
-- Every url row becomes a text note whose body is one paragraph holding the
-- link, so nothing the author saved is dropped: title, notes, provenance,
-- order and relations stay on the same id. The body must stay byte-identical
-- to `legacyUrlNoteBodyJson` in src/renderer/domain/library-item.ts, which the
-- sync kernel and checkpoint restore use for url rows from older builds.
-- The table CHECKs are left as published (a rebuild would drop every trigger
-- on library_item); new url rows are refused by the guards below instead.
UPDATE `library_item`
SET
  `kind` = 'text',
  `body_json` = json_object(
    'type', 'doc',
    'content', json_array(json_object(
      'type', 'paragraph',
      'content', json_array(json_object(
        'type', 'text',
        'marks', json_array(json_object('type', 'link', 'attrs', json_object('href', `external_url`))),
        'text', `external_url`
      ))
    ))
  ),
  `external_url` = NULL,
  `preview_image_url` = NULL
WHERE `kind` = 'url';
--> statement-breakpoint
CREATE TRIGGER `library_item_retired_url_insert`
BEFORE INSERT ON `library_item`
WHEN NEW.`kind` = 'url'
BEGIN
  SELECT RAISE(ABORT, 'url materials are retired');
END;
--> statement-breakpoint
CREATE TRIGGER `library_item_retired_url_update`
BEFORE UPDATE OF `kind` ON `library_item`
WHEN NEW.`kind` = 'url'
BEGIN
  SELECT RAISE(ABORT, 'url materials are retired');
END;
