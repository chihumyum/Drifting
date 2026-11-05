// Release screenshot scenes, evaluated in the renderer through the frontend
// debug bridge by scripts/capture-release-screenshots.ts. They run in the
// Debug development renderer, so they set state through the app's own stores
// (the settings and UI stores) and wait on the DOM until a scene has settled.
// Each scene runs as a job the driver polls: evaluations are bounded, scenes
// are not.
(() => {
  const VERSION = 1;
  if (window.__driftingShots && window.__driftingShots.version === VERSION) return 'already';
  const S = { version: VERSION, jobs: {} };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const frame = () => new Promise((resolve) => { requestAnimationFrame(() => resolve()); setTimeout(resolve, 250); });

  async function waitFor(find, timeout, what) {
    const start = performance.now();
    while (performance.now() - start < timeout) {
      let found = null;
      try { found = find(); } catch { found = null; }
      if (found) return found;
      await sleep(100);
    }
    throw new Error(`Timed out waiting for ${what}`);
  }

  const stores = async () => ({
    settings: (await import('/src/renderer/store/settings-store.ts')).useSettingsStore,
    ui: (await import('/src/renderer/store/ui-store.ts')).useUiStore,
  });

  /** Fonts loaded, two frames painted, then a pause for transitions to finish. */
  async function settle(ms) {
    await document.fonts.ready;
    await frame();
    await frame();
    await sleep(ms);
  }

  /**
   * No caret, selection or focus ring in the picture; with `escape`, no open
   * popover either (Escape would also close a Super View, so not there).
   */
  function quiet({ escape = false } = {}) {
    for (let i = 0; escape && i < 2; i += 1) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
    }
    if (document.activeElement && document.activeElement !== document.body && document.activeElement.blur) document.activeElement.blur();
    const selection = window.getSelection();
    if (selection) selection.removeAllRanges();
  }

  function scroller(element) {
    for (let node = element; node; node = node.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight + 10) return node;
    }
    return null;
  }

  /** Rectangles of the first elements matching `selector`, to tell when motion has stopped. */
  const positions = (selector) => [...document.querySelectorAll(selector)].slice(0, 40)
    .map((element) => { const r = element.getBoundingClientRect(); return `${Math.round(r.x)},${Math.round(r.y)}`; }).join(' ');

  async function still(selector, timeout) {
    const start = performance.now();
    let last = positions(selector);
    while (performance.now() - start < timeout) {
      await sleep(500);
      const now = positions(selector);
      if (now === last && now) return;
      last = now;
    }
  }

  S.scenes = {
    /** Interface language and theme, the first-run guides already seen; the page reloads to start clean. */
    async prepare({ locale, theme }) {
      const { settings } = await stores();
      const { alphaGuideStorageKey } = await import('/src/renderer/lib/alpha-guide-key.ts');
      const { LOCAL_USER_ID } = await import('/src/renderer/store/auth.ts');
      localStorage.setItem('drifting.markdown-folder-guide.v2', 'seen');
      localStorage.setItem(alphaGuideStorageKey(LOCAL_USER_ID), 'seen');
      // The workspace tour's first bubble would sit over the chapter list.
      settings.getState().markGuideSeen('workspace-tour');
      settings.getState().setUiLocale(locale);
      settings.getState().setThemeMode(theme);
      // Persisted stores write on change; give them a moment before the reload,
      // and the bridge time to answer this evaluation.
      setTimeout(() => location.reload(), 600);
      return { locale, theme };
    },

    async theme({ mode }) {
      const { settings } = await stores();
      settings.getState().setThemeMode(mode);
      await settle(1600);
      quiet();
      return document.documentElement.className;
    },

    /** Every book on the shelf with its cover drawn, and the year of writing. */
    async shelf({ books }) {
      await waitFor(() => document.querySelectorAll('button.pp-hit').length === books, 60000, `${books} books on the shelf`);
      await waitFor(() => [...document.querySelectorAll('.pp-cover')].every((cover) => cover.querySelector('.pp-cover__art, .pp-cover__band')),
        60000, 'every cover');
      await settle(2500);
      quiet({ escape: true });
      return { books: document.querySelectorAll('button.pp-hit').length };
    },

    /** The book open on one chapter, a few more in tabs, chapters on the left and Review on the right. */
    async workspace({ projectId, name, chapterId, tabs }) {
      const { ui } = await stores();
      if (!location.hash.includes(`/project/${projectId}`)) {
        const card = await waitFor(() => [...document.querySelectorAll('button.pp-hit')]
          .find((button) => (button.getAttribute('aria-label') || '').includes(name)), 30000, `the ${name} card`);
        card.click();
        await waitFor(() => location.hash.includes(`/project/${projectId}`), 30000, 'the book to open');
      }
      const state = ui.getState();
      state.setActiveSuperView('none');
      state.setSidebarOpen('left', true);
      state.setSidebarOpen('right', true);
      // Toggling the tab a pane already shows would close the sidebar.
      if (ui.getState().desktopSidebarTabs.left.panes[0].tab !== 'nodes') state.toggleLeftSidebarTab('primary', 'nodes');
      if (ui.getState().desktopSidebarTabs.right.panes[0].tab !== 'review') state.toggleRightSidebarTab('primary', 'review');
      for (const id of tabs) state.openEntityTab(projectId, { entityType: 'node', id }, { preview: false, activate: false });
      state.openEntityTab(projectId, { entityType: 'node', id: chapterId }, { preview: false, activate: true });
      const editor = await waitFor(() => [...document.querySelectorAll('.ProseMirror')].find((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && getComputedStyle(element).visibility === 'visible' && element.textContent.length > 200;
      }), 30000, 'the chapter text');
      await settle(2500);
      const scrolling = scroller(editor);
      if (scrolling) scrolling.scrollTop = 0;
      quiet({ escape: true });
      await settle(1500);
      return { tabs: ui.getState().tabsByProject[projectId].openTabs.length, words: editor.textContent.length };
    },

    /** The element overview in its 关系 layout, once the layout has come to rest. */
    async elements({ count }) {
      const { ui } = await stores();
      ui.getState().setActiveSuperView('element');
      await waitFor(() => document.querySelector('.super-view-head .se-layout-switch'), 30000, 'the element overview');
      await waitFor(() => document.querySelectorAll('.se-card--free').length >= count, 30000, `${count} elements in the 关系 layout`);
      await still('.se-card--free', 15000);
      await settle(1500);
      quiet();
      return { elements: document.querySelectorAll('.se-card--free').length };
    },
  };

  // Long scenes outlive one bridge evaluation; start them and poll the job.
  S.start = (id, name, options) => {
    S.jobs[id] = { state: 'running' };
    Promise.resolve()
      .then(() => S.scenes[name](options || {}))
      .then((value) => { S.jobs[id] = { state: 'done', value }; },
        (error) => { S.jobs[id] = { state: 'error', error: `${error}${error && error.stack ? `\n${error.stack}` : ''}` }; });
    return id;
  };
  window.__driftingShots = S;
  return 'installed';
})()
