-- AI usage — local token accounting for AI calls that EXECUTE on this client.
--
-- The principle (see project_element_arc / the usage design): usage is recorded
-- where the call runs. Hosted calls execute on the Drifting server and are metered
-- there (server `ai_usage`); calls that run locally (Shadow BYOK / direct-provider)
-- never touch the server, so their token usage is captured here instead. One row
-- per LLM call, tagged by `feature` ('shadow:review' | 'shadow:arc' | …). Tokens
-- only, no cost/$. `credentials_mode` records hosted|byok for forward-compat.

CREATE TABLE `ai_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`feature` text NOT NULL,
	`provider` text,
	`model` text,
	`credentials_mode` text,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cached_tokens` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_ai_usage_created` ON `ai_usage` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_ai_usage_feature` ON `ai_usage` (`feature`);
