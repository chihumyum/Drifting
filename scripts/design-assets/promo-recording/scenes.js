// Promo recording scenes (scripts/design-assets/promo-recording/README.md),
// evaluated in the renderer through the frontend debug bridge by record.ts.
// They set up what is off camera through the app's own stores and answer
// geometry questions (where the caret is, where a control is) so the rig can
// move the real pointer there; everything on camera is done with real input.
// Rectangles are viewport CSS pixels: {x, y, width, height}.
(() => {
  const VERSION = 1;
  if (window.__driftingPromo && window.__driftingPromo.version === VERSION) return 'already';
  const P = { version: VERSION, jobs: {} };
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
    agent: (await import('/src/renderer/store/agent-chat-store.ts')).useAgentChatStore,
  });

  const box = (rect) => (rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null);
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(element);
    return style.visibility === 'visible' && style.display !== 'none' && Number(style.opacity) > 0.05;
  };

  /** The chapter editor on screen: the visible ProseMirror under the paper. */
  function editor() {
    return [...document.querySelectorAll('.ProseMirror')].find((element) =>
      visible(element) && element.getAttribute('contenteditable') === 'true' && !element.closest('.agt-composer'));
  }

  function scroller(element) {
    for (let node = element; node; node = node.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight + 10) return node;
    }
    return null;
  }

  /** A visible element matching `selector`, optionally whose label or text contains `text`. */
  function find(selector, text, index = 0) {
    const matches = [...document.querySelectorAll(selector)].filter((element) => visible(element) && (!text
      || (element.getAttribute('aria-label') || '').includes(text)
      || (element.getAttribute('title') || '').includes(text)
      || (element.textContent || '').includes(text)));
    return matches[index] || null;
  }

  P.scenes = {
    /** Interface language, theme and Agent model, the first-run guides already seen; the page reloads to start clean. */
    async prepare({ locale, theme, provider, model }) {
      const { settings } = await stores();
      const { alphaGuideStorageKey } = await import('/src/renderer/lib/alpha-guide-key.ts');
      const { LOCAL_USER_ID } = await import('/src/renderer/store/auth.ts');
      localStorage.setItem('drifting.markdown-folder-guide.v1', 'seen');
      localStorage.setItem(alphaGuideStorageKey(LOCAL_USER_ID), 'seen');
      const state = settings.getState();
      // The workspace tour's first bubble would sit over the chapter list.
      state.markGuideSeen('workspace-tour');
      state.setUiLocale(locale);
      state.setThemeMode(theme);
      if (provider) state.setAgentProvider(provider);
      if (model) settings.getState().setAgentModel(model);
      setTimeout(() => location.reload(), 600);
      return { locale, theme, provider: settings.getState().agentProvider, model: settings.getState().agentModel };
    },

    /** The book open on its chapter, chapters on the left and Review on the right. */
    async open({ projectId, name, chapterId }) {
      const { ui } = await stores();
      if (!location.hash.includes(`/project/${projectId}`)) {
        const card = await waitFor(() => [...document.querySelectorAll('button.pp-hit')]
          .find((button) => (button.getAttribute('aria-label') || '').includes(name)), 60000, `the ${name} card`);
        card.click();
        await waitFor(() => location.hash.includes(`/project/${projectId}`), 30000, 'the book to open');
      }
      const state = ui.getState();
      state.setActiveSuperView('none');
      state.setSidebarOpen('left', true);
      state.setSidebarOpen('right', true);
      // One chapter has no timeline to speak of; the page gets the height.
      state.setBottomTimelineHidden(true);
      if (ui.getState().desktopSidebarTabs.left.panes[0].tab !== 'nodes') state.toggleLeftSidebarTab('primary', 'nodes');
      if (ui.getState().desktopSidebarTabs.right.panes[0].tab !== 'review') state.toggleRightSidebarTab('primary', 'review');
      state.openEntityTab(projectId, { entityType: 'node', id: chapterId }, { preview: false, activate: true });
      await waitFor(() => editor(), 30000, 'the chapter editor');
      await document.fonts.ready;
      await frame();
      await sleep(1500);
      const selection = window.getSelection();
      if (selection) selection.removeAllRanges();
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      return { viewport: P.scenes.viewport() };
    },

    /**
     * Opens, off camera, what the recording will open on camera, so the
     * development server has compiled it and optimized its dependencies
     * (a first use can reload the page) before the take starts.
     */
    async warmup() {
      const { ui } = await stores();
      const show = (side, tab) => {
        const state = ui.getState();
        if (state.desktopSidebarTabs[side].panes[0].tab === tab) return;
        if (side === 'left') state.toggleLeftSidebarTab('primary', tab);
        else state.toggleRightSidebarTab('primary', tab);
      };
      show('right', 'companion');
      await waitFor(() => document.querySelector('.agt-composer__text'), 30000, 'the Agent panel');
      await sleep(1200);
      show('left', 'elements');
      await sleep(800);
      ui.getState().setActiveSuperView('element');
      await sleep(3000);
      ui.getState().setActiveSuperView('none');
      await sleep(800);
      show('left', 'nodes');
      show('right', 'review');
      await sleep(1200);
      return 'warm';
    },

    viewport() {
      return { width: innerWidth, height: innerHeight, dpr: devicePixelRatio };
    },

    /** The caret in the chapter editor, or null when the selection is elsewhere. */
    caret() {
      const root = editor();
      const selection = window.getSelection();
      if (!root || !selection || !selection.rangeCount || !root.contains(selection.anchorNode)) return null;
      const range = selection.getRangeAt(0).cloneRange();
      range.collapse(false);
      let rect = [...range.getClientRects()].pop();
      if (!rect || (rect.height === 0 && rect.width === 0)) {
        const node = selection.anchorNode.nodeType === 1 ? selection.anchorNode : selection.anchorNode.parentElement;
        const block = node && node.closest('p, h1, h2, h3, blockquote');
        rect = block ? block.getBoundingClientRect() : null;
        if (rect) rect = { x: rect.x, y: rect.y, width: 1, height: Math.min(rect.height, 40) };
      }
      return box(rect);
    },

    /** The editor's text column and the paper around it. */
    column() {
      const root = editor();
      if (!root) return null;
      const paper = root.closest('.page, .paper, [class*="paper"]') || root;
      return { text: box(root.getBoundingClientRect()), paper: box(paper.getBoundingClientRect()) };
    },

    /** Where to click to put the caret at the end of the chapter's text. */
    end() {
      const root = editor();
      if (!root) return null;
      const blocks = root.querySelectorAll(':scope > *');
      const last = blocks[blocks.length - 1] || root;
      const rect = last.getBoundingClientRect();
      return { x: rect.x + Math.min(rect.width - 4, 24), y: rect.y + Math.min(rect.height / 2, 14) };
    },

    rect({ selector, text, index }) {
      const element = find(selector, text, index);
      return element ? box(element.getBoundingClientRect()) : null;
    },

    /** Every entity link in the chapter whose text is one of `names`, in reading order. */
    links({ names }) {
      const root = editor();
      if (!root) return [];
      return [...root.querySelectorAll('.entity-link')]
        .filter((element) => !names || names.some((name) => element.textContent.includes(name)))
        .map((element) => ({ text: element.textContent, rect: box(element.getBoundingClientRect()) }))
        .filter((link) => link.rect.width > 0 && link.rect.y > 0 && link.rect.y < innerHeight);
    },

    /** Where the element overview's cards lie, together. */
    cards() {
      const rects = [...document.querySelectorAll('.se-card--free')].filter(visible).map((element) => element.getBoundingClientRect());
      if (!rects.length) return null;
      const left = Math.min(...rects.map((rect) => rect.left)), top = Math.min(...rects.map((rect) => rect.top));
      const right = Math.max(...rects.map((rect) => rect.right)), bottom = Math.max(...rects.map((rect) => rect.bottom));
      return { x: left, y: top, width: right - left, height: bottom - top };
    },

    /** Comments anchored in the chapter, as the review leaves them. */
    async comments() {
      const highlights = [...document.querySelectorAll('[class*="comment-highlight"], [data-comment-id]')]
        .filter(visible).map((element) => ({ rect: box(element.getBoundingClientRect()), text: element.textContent.slice(0, 40) }));
      return highlights;
    },

    async agent() {
      const { agent } = await stores();
      const state = agent.getState();
      return {
        running: Object.keys(state.runningTurns || {}).length > 0,
        activeConvId: state.activeConvId,
      };
    },

    /** Scrolls the chapter so its end mark sits in view (off camera only). */
    async revealEnd() {
      const mark = document.querySelector('.page__ornament--menu');
      if (!mark) return null;
      mark.scrollIntoView({ block: 'center' });
      await sleep(400);
      return box(mark.getBoundingClientRect());
    },

    scroll() {
      const root = editor();
      const scrolling = root && scroller(root);
      return scrolling ? { top: scrolling.scrollTop, height: scrolling.scrollHeight, client: scrolling.clientHeight } : null;
    },
  };

  // Long scenes outlive one bridge evaluation; start them and poll the job.
  P.start = (id, name, options) => {
    P.jobs[id] = { state: 'running' };
    Promise.resolve()
      .then(() => P.scenes[name](options || {}))
      .then((value) => { P.jobs[id] = { state: 'done', value }; },
        (error) => { P.jobs[id] = { state: 'error', error: `${error}${error && error.stack ? `\n${error.stack}` : ''}` }; });
    return id;
  };
  window.__driftingPromo = P;
  return 'installed';
})()
