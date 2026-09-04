# Drifting Alpha known issues

This file tracks user-visible limitations for the next desktop Alpha. It is not
evidence that a public installer is available.

- Only macOS 13+ on Apple Silicon is in scope.
- Copilot and General Agent are experimental BYOK features. Review every
  proposed change before accepting it.
- The General Agent "ChatGPT subscription" route signs in with your own
  ChatGPT account through OpenAI's Codex device login. OpenAI offers no
  third-party contract for it, so it is unsupported, counts against your
  ChatGPT plan, and may stop working without notice.
- Google Drive synchronization trusts the selected Google account and Drive;
  synchronized manuscript data is not end-to-end encrypted against Google.
- Relational Markdown is a readable export and is not an app-state import or
  restore format.
- Public Alpha publication remains blocked until the dated two-Mac Drive,
  notarized distribution, updater, and desktop RC checklists are complete.
- Mobile, Intel Mac, Windows, and Linux are not release-supported yet.

Report reproducible problems to `hi@drifting.app` without attaching private
manuscript text, API keys, OAuth tokens, or credential screenshots.
