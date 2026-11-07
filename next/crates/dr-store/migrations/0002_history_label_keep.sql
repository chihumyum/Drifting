-- History labels that retention never removes (for example the history
-- points an import brings from 0.1, when the importer asks to keep them).
-- 0 = thinned and pruned after 30 days like every other label.
ALTER TABLE history_label ADD COLUMN keep INTEGER NOT NULL DEFAULT 0 CHECK (keep IN (0, 1));
