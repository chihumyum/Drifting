import { runEntityLinkPresentationScenarios } from './entity-link-presentation-scenarios';
import { runRetroactiveLinkMatchingScenarios } from './retroactive-link-matching-scenarios';
import { runRetroactiveEntityLinkScenarios } from './retroactive-entity-link-scenarios';
import { runEntityLinkTargetStateScenarios } from './entity-link-target-state-scenarios';
import { runStoryGraphUnplacedScenarios } from './story-graph-unplaced-scenarios';
import { runGraphDriftCardScenarios } from './graph-drift-card-scenarios';
import { runStoryGraphCardScenarios } from './story-graph-card-scenarios';
import { runAgentTranscriptScenarios } from './agent-transcript-scenarios';
import { runAgentBackgroundScenarios } from './agent-background-scenarios';
import { runSuperElementCardScenarios } from './super-element-card-scenarios';
import { runAgentRecoveryScenarios } from './agent-recovery-scenarios';
import { runAgentJournalScenarios } from './agent-journal-scenarios';
import { runEditorSuggestionScenarios } from './editor-suggestion-scenarios';
import { runInlineCopilotScenarios } from './copilot-inline-scenarios';
import { runInlineEditApplyScenarios } from './inline-edit-apply-scenarios';
import { runCopilotRunScenarios } from './copilot-run-scenarios';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { EntityLink, entityLinkConfig } from '../lib/extensions/entity-link';
import { DEFAULT_ENTITY_LINK_KIND_COLORS, resolveEntityLinkTargetColor, type EntityLinkColorState } from '../lib/entity-link-appearance';
import { useDataStore } from '../store/data-store';
import { createRendererFixture, RENDERER_FIXTURE_PROFILES } from './fixture';
import { runEntityLinkScenarios } from './entity-link-scenarios';
import { runWorkspaceGenerationScenario } from './workspace-generation-scenario';
import { runSemanticSubscriptionScenario, runSubscriptionScenarios } from './subscription-scenarios';
import { runAgentDecorationScenarios, runDecorationReadinessScenario } from './agent-decoration-scenarios';
import { runEntityLinkOwnershipScenarios } from './entity-link-ownership-scenarios';
import { runAgentEventScenarios } from './agent-event-scenarios';
import { runAgentDisplayScenarios } from './agent-display-scenarios';
import { runAgentHistoryScenarios } from './agent-history-scenarios';
import { runAgentPanelScenarios } from './agent-panel-scenarios';
import { runMobileAgentPanelScenarios } from './mobile-agent-panel-scenarios';
import { runGraphProjectionScenarios } from './graph-projection-scenarios';
import { runGraphGeometryScenarios } from './graph-geometry-scenarios';
import { runGraphOverlayScenarios } from './graph-overlay-scenarios';
import { runTimelineScenarios } from './timeline-scenarios';
import { runWorkspaceProjectionScenarios } from './workspace-projection-scenarios';
import { runEditorContextMenuScenarios } from './editor-context-menu-scenarios';

function summary(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    samples,
    median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)],
  };
}

async function run() {
  const scenarios = [];
  for (const options of RENDERER_FIXTURE_PROFILES) {
    const fixture = createRendererFixture(options);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(fixture)));
    const fixtureHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    const colorState = {
      bookElements: fixture.elements, bookElementCategories: fixture.categories,
      bookNodes: [], storylines: [], driftGroups: [], primaryStorylineByNode: {},
    } as unknown as EntityLinkColorState;
    const counts = { fullLinkQueries: 0, colorResolutions: 0, styleWrites: 0 };
    let count = false;
    entityLinkConfig.resolveTargetColor = (kind, id) => {
      if (count) counts.colorResolutions++;
      return resolveEntityLinkTargetColor(kind, id, colorState, 'contextual', DEFAULT_ENTITY_LINK_KIND_COLORS);
    };
    const element = document.createElement('div');
    document.body.appendChild(element);
    const editor = new Editor({ element, extensions: [StarterKit, EntityLink.configure({ autoDetectEnabled: false })], content: fixture.document });
    const query = editor.view.dom.querySelectorAll.bind(editor.view.dom);
    editor.view.dom.querySelectorAll = ((selector: string) => {
      if (count && selector.includes('.entity-link')) counts.fullLinkQueries++;
      return query(selector);
    }) as typeof editor.view.dom.querySelectorAll;
    const set = CSSStyleDeclaration.prototype.setProperty;
    const remove = CSSStyleDeclaration.prototype.removeProperty;
    CSSStyleDeclaration.prototype.setProperty = function (property, value, priority) {
      if (count && property === '--entity-link-color') counts.styleWrites++;
      return set.call(this, property, value, priority);
    };
    CSSStyleDeclaration.prototype.removeProperty = function (property) {
      if (count && property === '--entity-link-color') counts.styleWrites++;
      return remove.call(this, property);
    };
    try {
      // Insert before the first link, leaving all mark attributes unchanged.
      const insert = () => editor.view.dispatch(editor.state.tr.insertText('字', 1));
      for (let index = 0; index < 10; index++) insert();
      count = true;
      for (let index = 0; index < 100; index++) insert();
      count = false;
      const transactionMs: number[] = [];
      const transactionToAnimationFrameMs: number[] = [];
      for (let index = 0; index < 60; index++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const start = performance.now();
        insert();
        transactionMs.push(performance.now() - start);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        transactionToAnimationFrameMs.push(performance.now() - start);
      }
      scenarios.push({
        id: `editor-${options.characters}-${options.links}`, fixture: { ...options, hash: fixtureHash },
        warmupOperations: 10, countedOperations: 100, timingOperations: 60,
        counts, transactionMs: summary(transactionMs),
        transactionToAnimationFrameMs: summary(transactionToAnimationFrameMs),
        finalCharacters: editor.state.doc.textContent.length,
        finalLinks: editor.view.dom.querySelectorAll('.entity-link').length,
      });
    } finally {
      count = false;
      CSSStyleDeclaration.prototype.setProperty = set;
      CSSStyleDeclaration.prototype.removeProperty = remove;
      editor.destroy();
      element.remove();
      entityLinkConfig.resolveTargetColor = () => null;
    }
  }
  let allStoreNotifications = 0;
  let chapterSliceChanges = 0;
  const unsubscribe = useDataStore.subscribe((next, previous) => {
    allStoreNotifications++;
    if (next.bookNodes !== previous.bookNodes) chapterSliceChanges++;
  });
  try {
    for (let index = 0; index < 100; index++) useDataStore.getState().setComments([]);
  } finally { unsubscribe(); }
  return {
    scenarios,
    behaviorChecks: runEntityLinkScenarios(),
    reactSubscriptions: runSubscriptionScenarios(),
    semanticSubscriptions: runSemanticSubscriptionScenario(),
    workspaceGeneration: runWorkspaceGenerationScenario(),
    agentDecorations: runAgentDecorationScenarios(),
    decorationReadiness: runDecorationReadinessScenario(),
    entityLinkOwnership: await runEntityLinkOwnershipScenarios(),
    entityTargetState: runEntityLinkTargetStateScenarios(),
    entityLinkPresentation: await runEntityLinkPresentationScenarios(),
    retroactiveEntityLinks: await runRetroactiveEntityLinkScenarios(),
    retroactiveLinkMatching: await runRetroactiveLinkMatchingScenarios(),
    agentEventProcessing: await runAgentEventScenarios(),
    agentTranscript: await runAgentTranscriptScenarios(),
    agentBackground: await runAgentBackgroundScenarios(),
    agentRecovery: await runAgentRecoveryScenarios(),
    agentJournal: runAgentJournalScenarios(),
    agentDisplay: await runAgentDisplayScenarios(),
    agentPanel: await runAgentPanelScenarios(),
    agentHistory: await runAgentHistoryScenarios(),
    mobileAgentPanel: await runMobileAgentPanelScenarios(),
    graphProjection: await runGraphProjectionScenarios(),
    superElementCards: await runSuperElementCardScenarios(),
    storyGraphCards: await runStoryGraphCardScenarios(),
    storyGraphUnplaced: await runStoryGraphUnplacedScenarios(),
    graphDriftCards: await runGraphDriftCardScenarios(),
    graphGeometry: await runGraphGeometryScenarios(),
    graphOverlays: await runGraphOverlayScenarios(),
    timeline: await runTimelineScenarios(),
    workspaceProjection: await runWorkspaceProjectionScenarios(),
    editorContextMenus: await runEditorContextMenuScenarios(),
    editorSuggestions: await runEditorSuggestionScenarios(),
    inlineCopilot: await runInlineCopilotScenarios(),
    inlineEditApply: await runInlineEditApplyScenarios(),
    copilotRuns: await runCopilotRunScenarios(),
    subscriptions: { operations: 100, allStoreNotifications, chapterSliceChanges },
    environment: { documentFocused: document.hasFocus(), userAgent: navigator.userAgent, viewport: [innerWidth, innerHeight], devicePixelRatio },
  };
}

Object.assign(window, { __DRIFTING_PERFORMANCE_HARNESS__: { run } });
