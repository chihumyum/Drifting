import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const source = (path: string) => readFile(`${ROOT}${path}`, 'utf8');

/**
 * Machine-checkable acceptance for docs/agent-runtime/agent-onboarding.md:
 * the first run lives in the empty conversation, connects in place, sends a
 * suggestion as the author's words, lets the first change wait once, and is
 * reset from Settings.
 */
describe('Agent first-run acceptance', () => {
  it('turns the empty conversation into the guide and keeps the Settings link for started ones', async () => {
    const panel = await source('src/renderer/features/agent/desktop/DesktopAgentPanel.tsx');
    const transcript = await source('src/renderer/features/agent/desktop/DesktopAgentTranscript.tsx');
    expect(transcript).toContain('<AgentOnboarding view={onboardingView} onPick={onboarding.onPick} />');
    expect(transcript).toContain('resolveAgentOnboardingView({');
    expect(panel).toContain('{!usable && !transcriptConnects && <div style={hintBox} role="status">');
    expect(panel).toContain("railId: 'models'");
  });

  it('counts any send from the panel, and sends a suggestion through the composer', async () => {
    const panel = await source('src/renderer/features/agent/desktop/DesktopAgentPanel.tsx');
    expect(panel).toContain("noteAgentOnboarding({ type: 'sent' });");
    expect(panel).toMatch(/const handlePick = useCallback\(\(text: string\) => \{\s*setPrompt\(text\);\s*handleSend\(\);/);
  });

  it('lets the first change wait beside its version history until it is opened', async () => {
    const transcript = await source('src/renderer/features/agent/desktop/DesktopAgentTranscript.tsx');
    const chip = await source('src/renderer/features/agent/AgentMessageViews.tsx');
    expect(transcript).toContain('agentOnboardingWaitsOnChange(onboardingStep, turnRefs.length)');
    expect(transcript).toContain("events.emit('snapshot-history:open', { entityKind: ref.entityType, entityId: ref.id })");
    expect(transcript).toContain("const noteChangeSeen = () => noteAgentOnboarding({ type: 'change-seen' });");
    expect(transcript.match(/noteChangeSeen\(\);/g)).toHaveLength(2);
    expect(chip).toContain("(waiting ? ' glass--waiting agt-entity-chip--waiting' : '')");
  });

  it('gives every Agent prose write a restore point in the version history it points to', async () => {
    const prose = await source('src/renderer/lib/agent/chapter-prose.ts');
    const body = prose.slice(prose.indexOf('async function writeProseDoc('), prose.indexOf('/** The per-entity contentJson projection cache'));
    const captures = [...body.matchAll(/maybeCaptureSnapshotHistory\(docId, [^)]*\), 'agent'\);|maybeCaptureSnapshotHistory\(docId, seed, 'agent'\);/g)];
    const transacts = [...body.matchAll(/\.transact\(/g)];
    expect(captures).toHaveLength(3);
    expect(transacts).toHaveLength(3);
    captures.forEach((capture, index) => expect(capture.index).toBeLessThan(transacts[index].index!));
    const coordinator = await source('src/renderer/lib/agent/runtime/yjs-prose-persistence-coordinator.ts');
    const commit = coordinator.slice(coordinator.indexOf('  async commit('));
    expect(commit.indexOf("if (input.direction === 'forward') await captureRestorePoint(input.command.base);"))
      .toBeLessThan(commit.indexOf('this.database().transaction('));
  });

  it('adds keys only through the tested connect path; Settings still owns editing and removal', async () => {
    const onboarding = await source('src/renderer/features/agent/onboarding/AgentOnboarding.tsx');
    const connect = await source('src/renderer/lib/agent/connect-agent-provider.ts');
    expect(onboarding).toContain('connectAgentProviderKey(provider, draft)');
    expect(onboarding).not.toMatch(/byokKeychain\.(set|clear|get)\(/);
    expect(onboarding).not.toContain('codexSubscription.logout');
    expect(connect.indexOf('dependencies.test(provider)')).toBeLessThan(connect.indexOf('selectAgentProvider(provider, dependencies)'));
    expect(connect).toContain('await dependencies.clearKey(provider)');
  });

  it('shows once per device, skips existing Agent users, and is reset in Settings', async () => {
    const settings = await source('src/renderer/store/settings-store.ts');
    const agentSettings = await source('src/renderer/features/settings/panels/AgentSettingsPanel.tsx');
    expect(settings).toContain('export const SETTINGS_STORAGE_VERSION = 33;');
    expect(settings).toContain('next.agentOnboardingStep = agentOnboardingStepForExistingInstall(next.lastAgentConvByProject);');
    expect(agentSettings).toContain("setStep(nextAgentOnboardingStep(step, { type: 'reset' }))");
    expect(agentSettings).toContain('<ReplayOnboardingButton />');
  });
});
