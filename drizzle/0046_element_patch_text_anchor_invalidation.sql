-- Element patch — text-fragment anchor + invalidation.
--
-- `text_anchor_json` stores a precise CommentTextAnchor (startBlockId,
-- startOffset, endBlockId, endOffset, text) for patches created by selecting a
-- span of prose in a chapter. NULL for floating / block-only / chapter-only
-- patches (e.g. the element-page "+ 新建" floating patch, or Copilot accepts).
--
-- `invalidated_at` is set (ISO timestamp) when the anchored source text is
-- deleted/rewritten out of the source chapter, and cleared (NULL) again if the
-- text reappears (undo). Invalidated patches are EXCLUDED from Shadow / agent
-- canon context — deleted evidence is no longer a sanctioned evolution — but
-- still shown (badged) in the element editor so the user can act on them.
-- Stored as TEXT so it round-trips unchanged through the JSON sync payload.

ALTER TABLE `element_patch` ADD COLUMN `text_anchor_json` text;--> statement-breakpoint
ALTER TABLE `element_patch` ADD COLUMN `invalidated_at` text;
