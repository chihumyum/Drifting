-- Element aliases.
--
-- Adds an `aliases_json` column to the element table to hold a JSON-encoded
-- string[] of alternate names ("Lady Mira", "M.", "the heir"). Used by:
--   - EntityLink auto-detect plugin: each alias registers as an additional
--     match target pointing at the same element id
--   - Inline mention projection: aliases match the same canonical entity
--   - Copilot entity-candidate dedup: an alias is not a new entity
--   - Copilot element-patch context: model is told aliases are equivalent
--
-- Uniqueness across (name + aliases) is enforced in the application layer
-- (useBookElement), not by a SQLite constraint — the values live JSON-
-- encoded in a single column so a UNIQUE index would only constrain the
-- whole array, not individual names. App-layer enforcement also lets us
-- return a structured error pointing at the conflicting peer.

ALTER TABLE `element` ADD COLUMN `aliases_json` text NOT NULL DEFAULT '[]';
