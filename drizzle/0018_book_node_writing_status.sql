-- Add chapter writing status to book_node. Default 'draft' so existing rows
-- backfill cleanly. Enum lives in the domain layer (WritingStatus): draft |
-- waiting_review | revising | finished. Today only draft / finished are user-
-- selectable; the two intermediate states are reserved for the AI-review
-- pipeline (not yet implemented).
ALTER TABLE `book_node` ADD COLUMN `writing_status` text DEFAULT 'draft' NOT NULL;
