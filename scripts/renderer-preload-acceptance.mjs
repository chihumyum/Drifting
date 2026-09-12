import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

const required = ['idle-and-abandoned-intent', 'warm-first-open', 'failed-preload-first-demand',
  'queued-intent-cancellation', 'foreground-bypasses-preload', 'save-data-skips-speculation'];
export function validatePreloadAcceptance(report) {
  assert.deepEqual(report.scenarios.map(item => item.id), required);
  for (const scenario of report.scenarios) {
    assert.equal(scenario.status, 'passed');
    assert.equal(scenario.editorPreserved, true, scenario.id);
    for (const [name, result] of Object.entries(scenario.checks)) assert.equal(result, true, `${scenario.id}: ${name}`);
  }
  assert.equal(report.native, 'not-run');
  assert.equal(report.firstUseBudget, 'not-run');
}

export async function runPreloadAcceptance({ page, origin, clients }) {
  const scenarios = [];
  async function scenario(id, gates, run, saveData = false) {
    const p = await page(); const requests = []; const held = [];
    try {
      if (saveData) await p.client.Page.addScriptToEvaluateOnNewDocument({ source:
        'Object.defineProperty(navigator, "connection", { configurable: true, value: { saveData: true, effectiveType: "4g" } });' });
      await p.client.Fetch.enable({ patterns: ['*graph-ui-*.js*', '*story-graph-*.js*', '*element-graph-*.js*', '*settings-panels-*.js*'].map(urlPattern => ({ urlPattern, requestStage: 'Request' })) });
      p.client.Fetch.requestPaused(event => {
        const url = new URL(event.request.url);
        const kind = url.pathname.includes('/graph-ui-') ? 'shared' : url.pathname.includes('/story-graph-') ? 'story' : url.pathname.includes('/element-graph-') ? 'element' : 'settings';
        const entry = url.searchParams.has(kind === 'settings' ? 'settings-attempt' : 'graph-attempt');
        if (entry) requests.push({ kind, url: url.pathname + url.search });
        if (entry && gates[kind] === 'fail-once') {
          gates[kind] = 'pass';
          void p.client.Fetch.failRequest({ requestId: event.requestId, errorReason: 'InternetDisconnected' });
        } else if (entry && gates[kind] === 'hold') held.push(event.requestId);
        else void p.client.Fetch.continueRequest({ requestId: event.requestId });
      });
      await p.navigate(`${origin}scripts/renderer-graphs-ui.html?preload`);
      await p.until('Boolean(document.querySelector(".workspace-super-trigger")) && Boolean(document.querySelector(".tiptap"))');
      const before = await p.evaluate('window.__GRAPHS_UI__.inspect()');
      const focus = async selector => {
        await p.evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
        assert(await p.evaluate(`document.activeElement === document.querySelector(${JSON.stringify(selector)})`), `${id}: real browser focus`);
      };
      const hover = async selector => {
        const point = await p.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
        await p.client.Input.dispatchMouseEvent({ type: 'mouseMoved', ...point }); return point;
      };
      const leave = () => p.client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: 1100, y: 700 });
      const release = async () => { for (const requestId of held.splice(0)) await p.client.Fetch.continueRequest({ requestId }); };
      const waitRequest = async kind => { for (let n = 0; n < 200 && !requests.some(r => r.kind === kind); n++) await delay(25); assert(requests.some(r => r.kind === kind), `${id}: ${kind} request`); };
      const loadedStory = () => p.until('performance.getEntriesByType("resource").some(e => e.name.includes("story-graph-") && e.transferSize > 0)');
      const result = await run({ ...p, focus, hover, leave, release, waitRequest, loadedStory, requests, held });
      const after = await p.evaluate('window.__GRAPHS_UI__.inspect()');
      const prosePreserved = id === 'warm-first-open'
        ? after.text.includes(' synthetic edit') && after.text.replace(' synthetic edit', '') === before.text
        : after.text === before.text;
      const editorPreserved = before.editorId === after.editorId && after.mounts === 1 && after.unmounts === 0 && prosePreserved;
      const record = { id, status: 'passed', editorPreserved, ...result, requests };
      assert(editorPreserved, id);
      for (const [name, passed] of Object.entries(record.checks)) assert.equal(passed, true, `${id}: ${name}`);
      scenarios.push(record);
    } finally { await p.client.close(); clients.delete(p.client); }
  }

  await scenario(required[0], {}, async p => {
    await delay(250); const idle = p.requests.length === 0;
    const point = await p.hover('.workspace-super-trigger'); await p.leave();
    await p.client.Input.dispatchTouchEvent({ type: 'touchStart', touchPoints: [{ ...point }] });
    await p.client.Input.dispatchTouchEvent({ type: 'touchCancel', touchPoints: [] });
    await p.focus('.workspace-super-trigger'); await p.focus('.tiptap'); await delay(300);
    const abandoned = p.requests.length === 0;
    await p.focus('.workspace-super-trigger');
    await p.evaluate('Object.defineProperty(document, "visibilityState", { configurable: true, get: () => window.__syntheticVisibility }); window.__syntheticVisibility = "hidden"; document.dispatchEvent(new Event("visibilitychange")); window.__syntheticVisibility = "visible"; document.dispatchEvent(new Event("visibilitychange"));');
    await delay(300);
    return { checks: { idleDoesNotLoad: idle, hoverFocusAndTouchCancel: abandoned, syntheticVisibilityCancels: p.requests.length === 0, noFeatureMount: await p.evaluate('window.__GRAPHS_UI__.observations.active === "none" && !document.querySelector(".graph-overlay")') } };
  });
  await scenario(required[1], { story: 'hold' }, async p => {
    await p.hover('.workspace-super-trigger'); await p.waitRequest('story');
    await p.evaluate('window.__GRAPHS_UI__.edit()');
    const editedDuringPreload = p.held.length === 1 && await p.evaluate('window.__GRAPHS_UI__.inspect().text.includes("synthetic edit")');
    await p.release(); await p.loadedStory(); await p.leave();
    const noFeatureMount = await p.evaluate('window.__GRAPHS_UI__.observations.active === "none" && !document.querySelector(".graph-overlay")');
    await p.evaluate('window.__preloadStatuses = 0; new MutationObserver(records => { for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1 && (n.matches("[role=status]") || n.querySelector("[role=status]"))) window.__preloadStatuses++; }).observe(document.getElementById("root"), { childList: true, subtree: true }); window.__preloadClickAt = performance.now(); document.querySelector(".workspace-super-trigger").click();');
    await p.until('Boolean(document.querySelector(".graph-overlay .graph-tile"))');
    return { checks: { editedDuringPreload, noFeatureMountBeforeClick: noFeatureMount, onlySelectedCode: p.requests.length === 2 && p.requests[0].kind === 'shared' && p.requests[1].kind === 'story', firstOpenWithoutFallback: await p.evaluate('window.__preloadStatuses === 0') }, clickToObservedGraphMs: await p.evaluate('performance.now() - window.__preloadClickAt') };
  });
  await scenario(required[2], { shared: 'fail-once' }, async p => {
    await p.focus('.workspace-super-trigger'); await p.waitRequest('shared'); await delay(150);
    const invisibleFailure = await p.evaluate('!document.querySelector("[role=alert]") && window.__GRAPHS_UI__.observations.active === "none"');
    await p.evaluate('window.__preloadAlerts = 0; new MutationObserver(records => { for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1 && (n.matches("[role=alert]") || n.querySelector("[role=alert]"))) window.__preloadAlerts++; }).observe(document.getElementById("root"), { childList: true, subtree: true }); document.querySelector(".workspace-super-trigger").click();');
    await p.until('Boolean(document.querySelector(".graph-overlay .graph-tile"))');
    const shared = p.requests.filter(r => r.kind === 'shared');
    return { checks: { invisibleFailure, firstDemandNeedsNoRetryClick: await p.evaluate('window.__preloadAlerts === 0'), freshFetchKey: shared.length === 2 && shared[0].url !== shared[1].url, bodyFetchedOnce: p.requests.filter(r => r.kind === 'story').length === 1 } };
  });
  await scenario(required[3], { shared: 'hold' }, async p => {
    await p.focus('.workspace-super-trigger'); await p.waitRequest('shared');
    await p.evaluate('window.__GRAPHS_UI__.navigate("/settings")'); await p.until('Boolean(document.querySelector(".set-rail__item"))');
    await p.focus('.set-rail__item'); await delay(250);
    const queueWaited = p.held.length === 1 && !p.requests.some(r => r.kind === 'settings');
    await p.focus('.set-head__back'); await p.evaluate('document.querySelector(".set-head__back").click()');
    await p.until('Boolean(document.querySelector(".workspace-super-trigger"))');
    await p.release(); await p.loadedStory(); await delay(300);
    return { checks: { queueWaited, canceledBeforeStart: !p.requests.some(r => r.kind === 'settings'), lateImportDidNotNavigate: await p.evaluate('window.__GRAPHS_UI__.observations.active === "none" && !document.querySelector(".graph-overlay")') } };
  });
  await scenario(required[4], { shared: 'hold' }, async p => {
    await p.focus('.workspace-super-trigger'); await p.waitRequest('shared');
    await p.evaluate('window.__GRAPHS_UI__.navigate("/settings")'); await p.until('Boolean(document.querySelector(".set-rail__item"))');
    await p.focus('.set-rail__item'); await p.evaluate('document.querySelector(".set-rail__item").click()');
    await p.until('Boolean(document.querySelector("#appearance"))', 'actual settings panel while graph preload is held');
    const bypassed = p.held.length === 1 && p.requests.some(r => r.kind === 'settings');
    await p.release(); await p.loadedStory();
    return { checks: { demandBypassedOtherPreload: bypassed, settingsLoadedOnce: p.requests.filter(r => r.kind === 'settings').length === 1, lateGraphDidNotMount: await p.evaluate('!document.querySelector(".graph-overlay") && Boolean(document.querySelector("#appearance"))') } };
  });
  await scenario(required[5], {}, async p => {
    await p.focus('.workspace-super-trigger'); await delay(350); const noSpeculation = p.requests.length === 0;
    await p.evaluate('document.querySelector(".workspace-super-trigger").click()'); await p.until('Boolean(document.querySelector(".graph-overlay .graph-tile"))');
    return { checks: { noSpeculation, demandStillWorks: p.requests.length === 2 } };
  }, true);
  const report = { scenarios, native: 'not-run', firstUseBudget: 'not-run',
    limitations: ['Synthetic Tiptap/Yjs, actual workspace entry and mobile settings controls. No ChapterEditor or ProjectRuntimeProvider.',
      'Hover/focus/touch cancellation uses browser input; visibility and connection policy inputs are synthetic. No physical touch or native lifecycle acceptance.',
      'Observed click time includes automation observation latency and is diagnostic only. No F0 p95 or full-app startup budget is inferred.'] };
  validatePreloadAcceptance(report); return report;
}
