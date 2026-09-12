import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { EntityLink, entityLinkConfig } from '../lib/extensions/entity-link';
import { DEFAULT_ENTITY_LINK_KIND_COLORS, resolveEntityLinkTargetColor, type EntityLinkColorState } from '../lib/entity-link-appearance';
import { useDataStore } from '../store/data-store';
import { createRendererFixture, RENDERER_FIXTURE_PROFILES } from './fixture';
import { runEntityLinkScenarios } from './entity-link-scenarios';
import { runSemanticSubscriptionScenario, runSubscriptionScenarios } from './subscription-scenarios';

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
    entityLinkConfig.autoDetectEnabled = false;
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
    subscriptions: { operations: 100, allStoreNotifications, chapterSliceChanges },
    environment: { userAgent: navigator.userAgent, viewport: [innerWidth, innerHeight], devicePixelRatio },
  };
}

Object.assign(window, { __DRIFTING_PERFORMANCE_HARNESS__: { run } });
