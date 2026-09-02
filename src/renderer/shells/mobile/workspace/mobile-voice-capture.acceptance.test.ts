import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const rendererRoot = path.resolve(import.meta.dirname, '../../..');
const repoRoot = path.resolve(rendererRoot, '../..');
const source = (relative: string) => fs.readFileSync(path.join(rendererRoot, relative), 'utf8');
const repoFile = (relative: string) => fs.readFileSync(path.join(repoRoot, relative), 'utf8');

describe('Voice capture acceptance wiring', () => {
  it('owns the voice surface in the workspace controller with origin-preserving Back', () => {
    const controller = source('shells/mobile/workspace/mobile-workspace-controller.ts');
    expect(controller).toContain("| { kind: 'voice'; returnTo: 'project-home' | 'paper' }");
    expect(controller).toContain("{ type: 'show-voice' }");
    expect(controller).toContain("case 'show-voice':");
    expect(controller).toContain("if (state.surface.kind === 'voice') {");
  });

  it('mounts the floating pill and fullscreen face above every workspace surface', () => {
    const shell = source('shells/mobile/MobileAppShell.tsx');
    expect(shell).toContain('useVoiceCaptureStore.getState().openSession(projectId)');
    expect(shell).toContain('<MobileVoiceFace projectId={projectId} />');
    expect(shell).toContain('<MobileVoicePill onExpand=');
    expect(shell).toContain('onOpenVoice={openVoice}');

    const home = source('shells/mobile/workspace/MobileProjectHome.tsx');
    expect(home).toContain('onClick={onOpenVoice}');

    const css = repoFile('src/styles/mobile-workspace.css');
    expect(css).toContain('.m-voice-pill');
    expect(css).toContain('.m-voice-face__mic');
  });

  it('sends voice-authored turns through the shared runtime with write access and evidence', () => {
    const face = source('shells/mobile/workspace/MobileVoiceFace.tsx');
    expect(face).toContain("send({ turnContext, toolAccess: 'read_write' })");
    expect(face).toContain('buildVoiceContextPackFromStores');
    expect(face).toContain('collectMobileAgentEvidence(messages)');
    expect(face).toContain("requestMobileWorkspaceBack('visible')");
  });

  it('reuses one dictation pipeline in the desktop composer and the mobile Agent panel', () => {
    expect(source('features/agent/desktop/DesktopAgentPanel.tsx')).toContain(
      '<VoiceDictationButton',
    );
    expect(source('shells/mobile/workspace/MobileAgentPanel.tsx')).toContain(
      '<VoiceDictationButton',
    );
    const store = source('store/voice-capture-store.ts');
    expect(store).toContain('speechKeychain.get()');
    expect(store).toContain("'voiceAgent.error.noKey'");
    expect(store).toContain("'voiceAgent.error.recordingFailed'");
    expect(store).toContain('useAgentChatStore');
    const recorder = source('lib/speech/voice-recorder.ts');
    expect(recorder).toContain('VOICE_RECORDER_STOP_TIMEOUT_MS');
    expect(recorder).toContain("'track-ended'");
    expect(recorder).toContain('recorder.onerror');
    const cssShared = repoFile('src/styles/agent-panel.css');
    expect(cssShared).toContain('.agt-mic');
  });

  it('opts the macOS WKWebView into media capture and spells out every capture state', () => {
    const rust = repoFile('src-tauri/src/webview_media.rs');
    expect(rust).toContain('mediaDevicesEnabled');
    expect(rust).toContain('respondsToSelector(objc2::sel!(_setMediaDevicesEnabled:))');
    expect(repoFile('src-tauri/src/lib.rs')).toContain(
      'webview_media::enable_media_devices(&window)?;',
    );
    expect(repoFile('src-tauri/Cargo.toml')).toContain('objc2-web-kit');

    const button = source('features/agent/VoiceDictationButton.tsx');
    expect(button).toContain('className="agt-mic__status"');
    expect(button).toContain("t('voiceAgent.tapToStop')");
    expect(button).toContain('onClick={retryTranscription}');
    const store = source('store/voice-capture-store.ts');
    expect(store).toContain('function reportVoiceFailure(');
    expect(store).toContain("'support check'");
    expect(store).toContain("reportVoiceFailure('getUserMedia'");
  });

  it('restores project proper nouns by pinyin after transcription on every surface', () => {
    const store = source('store/voice-capture-store.ts');
    expect(store).toContain('correctTranscriptByPinyin(text, captureGlossary)');
    expect(store).toContain('appendToAgentPrompt(restored.text)');
    expect(source('features/agent/VoiceDictationButton.tsx')).toContain(
      'glossary: buildVoiceGlossaryFromStores(projectId)',
    );
    expect(source('shells/mobile/workspace/MobileVoiceFace.tsx')).toContain(
      'glossary: buildVoiceGlossaryFromStores(projectId)',
    );
    const correction = source('lib/speech/pinyin-correction.ts');
    expect(correction).toContain("import('pinyin-pro')");
    expect(correction).toContain('FUZZY_MIN_SYLLABLES = 3');
    expect(repoFile('package.json')).toContain('"pinyin-pro"');
  });

  it('keeps the BYOK transcription credential in the keychain, off the LLM provider union', () => {
    const credentials = source('lib/speech/speech-credentials.ts');
    expect(credentials).toContain("const KEY_ID = 'byok.dashscope'");
    expect(credentials).not.toContain("from '../byok-keychain'");
    const dashscope = source('lib/speech/dashscope-transcription.ts');
    expect(dashscope).toContain(
      'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
    );
    const settings = source('features/settings/panels/IntelligenceSettingsPanels.tsx');
    expect(settings).toContain('<SpeechCredentialRow credentialsActive={credentialsActive} />');
  });

  it('declares microphone usage and the DashScope origin on every platform', () => {
    const conf = repoFile('src-tauri/tauri.conf.json');
    const parsed = JSON.parse(conf) as {
      app: { security: { csp: string; devCsp: string } };
    };
    expect(parsed.app.security.csp).toContain('https://dashscope.aliyuncs.com');
    expect(parsed.app.security.devCsp).toContain('https://dashscope.aliyuncs.com');

    expect(repoFile('src-tauri/gen/apple/drifting_iOS/Info.plist')).toContain(
      'NSMicrophoneUsageDescription',
    );
    expect(repoFile('src-tauri/Info.plist')).toContain('NSMicrophoneUsageDescription');
    expect(repoFile('src-tauri/gen/android/app/src/main/AndroidManifest.xml')).toContain(
      'android.permission.RECORD_AUDIO',
    );
  });

  it('ships identical voice copy keys in both locales', () => {
    const zh = JSON.parse(source('locales/zh-CN.json')) as Record<string, unknown>;
    const en = JSON.parse(source('locales/en.json')) as Record<string, unknown>;
    for (const bundle of [zh, en]) {
      const voice = bundle.voiceAgent as Record<string, unknown>;
      expect(voice).toBeTruthy();
      for (const key of [
        'entryAria',
        'title',
        'expand',
        'collapse',
        'endSession',
        'record',
        'stopRecord',
        'tapToStop',
        'recording',
        'transcribing',
        'corrected',
        'retry',
        'empty',
        'hint',
        'composerPlaceholder',
      ]) {
        expect(voice[key], `voiceAgent.${key}`).toBeTruthy();
      }
      const errors = voice.error as Record<string, unknown>;
      for (const key of [
        'noKey',
        'unsupported',
        'micDenied',
        'recordingFailed',
        'auth',
        'segmentRejected',
        'transcribeFailed',
      ]) {
        expect(errors[key], `voiceAgent.error.${key}`).toBeTruthy();
      }
      const models = (bundle.settings as Record<string, Record<string, unknown>>).models;
      expect((models.providers as Record<string, unknown>).dashscope).toBeTruthy();
      expect(models.speechTitle).toBeTruthy();
      expect(models.speechDesc).toBeTruthy();
    }
  });
});
