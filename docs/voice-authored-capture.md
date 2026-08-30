# Voice-authored writing

Status: **Implemented in source, but not accepted or released as working behavior.**

The current code and deterministic tests establish the intended wiring only.
The maintainer has not tested this feature end to end. Microphone permission,
WKWebView/Android WebView recording, real DashScope transcription, long-recording
segmentation, background/surface transitions, and the resulting read-write Agent
turn must all be treated as unverified until the physical-device checklist below
has been completed. Do not describe this capability as shipped based on source or
automated tests alone.

Updated: 2026-08-30

## Direction

Voice → Agent creation is a core mobile capability. The author speaks story
material whenever typing is inconvenient (in bed, walking, commuting);
Drifting transcribes it with project-aware proper-noun biasing and hands it to
the read-write Agent, which grounds the capture in the project's canon.

> 你只管把故事说出来。Drifting 会带着你的元素表准确转写，交给 Agent 落进项目。

## Present in source (unaccepted)

- **BYOK transcription credential** — 阿里云百炼 (DashScope) `qwen3-asr-flash`,
  key stored in the OS keychain as `byok.dashscope` (deliberately not part of
  the `BYOKProvider` LLM union), managed under Settings → Models & API → 语音转写
  (`SpeechCredentialRow`). Requests go directly from the device to
  `dashscope.aliyuncs.com`; no Drifting server is involved.
  `VITE_DASHSCOPE_API_KEY` is the dev-only env override.
- **Project-aware recognition context** — `lib/speech/voice-context-pack.ts`
  compresses element names + aliases (via `allElementNames`), storyline names,
  and chapter/drift titles into the biasing text injected as the qwen3-asr
  system message. Priority under the budget: elements > storylines > chapters
  > drifts.
- **Recording pipeline** — `lib/speech/voice-recorder.ts` +
  `store/voice-capture-store.ts`: explicit tap-to-record, rolling ≤4-minute
  standalone segments (within the sync API's ~10MB/5-minute caps), ordered
  transcription, transcript appended to the shared Agent composer prompt as
  each segment resolves. Failed segments are retained in memory for retry;
  recording is an explicit author action, never ambient listening; raw audio
  is not retained after transcription.
- **Mobile surfaces** — Project Home gains a mic entry that opens the
  fullscreen voice-Agent face (a `voice` workspace surface owned by
  `mobile-workspace-controller.ts`); Back or the chevron collapses it to a
  floating pill (`MobileVoicePill`) that stays above every workspace surface
  while the session lives, so the author can keep speaking while reading
  their material; ✕ ends the session. Sends from the face run
  `toolAccess: 'read_write'` and changes surface in the evidence list.
- **Composer mic everywhere** — the mobile Agent panel and the desktop
  composer both mount `VoiceDictationButton`, feeding the same pipeline.
- **Mobile Agent is read-write** — the panel now sends
  `toolAccess: 'read_write'`, same as desktop; the former answer-only
  boundary and its copy were retired deliberately.
- **Native declarations** — mic usage strings (iOS `Info.plist`, macOS
  `src-tauri/Info.plist`), Android `RECORD_AUDIO`, and the DashScope origin in
  both CSP strings of `tauri.conf.json`.

Deterministic source evidence (not product acceptance): `shells/mobile/workspace/mobile-voice-capture.acceptance.test.ts`,
`shells/mobile/workspace/mobile-workspace-controller.test.ts` (voice surface),
`lib/speech/dashscope-transcription.test.ts`, `lib/speech/voice-context-pack.test.ts`.

## Product principles

- Never lose a capture because the network, AI, or app session failed.
- Preserve the author's meaning and voice; transcription cleans nothing by
  itself — normalization and expansion belong to the Agent turn the author
  sends.
- Do not silently make large, contradictory, or destructive changes; every
  Agent change stays visible through the evidence list.
- Do not retain raw audio by default.
- Voice capture is an explicit author action, never ambient listening.

## Open — not implemented

- Semantic routing UI: the Agent places material within a normal read-write
  turn today; there is no dedicated capture-routing result screen.
- Durable capture across app kill: segments live in memory until transcribed;
  a killed app loses an untranscribed segment.
- Background processing while the phone is locked (foreground-only MVP).
- End-to-end acceptance has not been performed. It must cover mic permission
  flows, WKWebView / Android WebView `getUserMedia` + `MediaRecorder`, a real
  DashScope request, long-segment ordering, surface collapse/restore, and the
  resulting Agent turn. The physical-device gate is tracked in
  [`mobile-device-acceptance.md`](mobile-device-acceptance.md).
- Additional transcription providers (火山引擎 Seed-ASR) behind the same
  `SpeechTranscriptionProvider` seam.
- Built-in on-device recognition (sherpa-onnx + SenseVoice) if offline capture
  becomes a requirement.
