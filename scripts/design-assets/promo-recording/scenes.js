// Promo recording scenes (scripts/design-assets/promo-recording/README.md),
// evaluated in the renderer through the frontend debug bridge by record.ts.
// They set up what is off camera through the app's own stores and answer
// geometry questions (where the caret is, where a control is) so the rig can
// move the real pointer there; everything on camera is done with real input.
// Rectangles are viewport CSS pixels: {x, y, width, height}.
(() => {
  const VERSION = 2;
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

    /** The shelf, every cover drawn, scrolled to the top; where the new-book card is. */
    async shelf() {
      if (location.hash.includes('/project/')) location.hash = '#/';
      await waitFor(() => document.querySelector('.pp-card--new') && document.querySelectorAll('button.pp-hit').length > 0, 60000, 'the shelf');
      await waitFor(() => [...document.querySelectorAll('.pp-cover')].every((cover) => cover.querySelector('.pp-cover__art, .pp-cover__band')),
        60000, 'every cover');
      const scrolling = scroller(document.querySelector('.pp-card--new'));
      if (scrolling) scrolling.scrollTop = 0;
      await document.fonts.ready;
      await frame();
      await sleep(1500);
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      return { viewport: P.scenes.viewport(), card: box(document.querySelector('.pp-card--new').getBoundingClientRect()) };
    },

    /**
     * Off camera, opens a book on the shelf and everything the take will open
     * on camera in its own book (the Agent's panel, the element overview,
     * immersive writing), so the development server has compiled them before
     * the take starts; then back to the shelf.
     */
    async warmupBook({ name }) {
      const { ui } = await stores();
      const card = await waitFor(() => [...document.querySelectorAll('button.pp-hit')]
        .find((button) => (button.getAttribute('aria-label') || '').includes(name)), 60000, `the ${name} card`);
      card.click();
      await waitFor(() => location.hash.includes('/project/'), 30000, 'the book to open');
      await sleep(2500);
      const state = ui.getState();
      state.setSidebarOpen('left', true);
      state.setSidebarOpen('right', true);
      const show = (side, tab) => {
        const current = ui.getState();
        if (current.desktopSidebarTabs[side].panes[0].tab === tab) return;
        if (side === 'left') current.toggleLeftSidebarTab('primary', tab);
        else current.toggleRightSidebarTab('primary', tab);
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
      ui.getState().setImmersiveWriting(true);
      await sleep(1200);
      ui.getState().setImmersiveWriting(false);
      await sleep(800);
      show('left', 'nodes');
      show('right', 'review');
      await sleep(800);
      location.hash = '#/';
      await sleep(1500);
      return 'warm';
    },

    /** The new-book dialog: its name field and its create button. */
    newBookDialog() {
      const dialog = document.querySelector('.modal-root__dialog');
      if (!dialog || !visible(dialog)) return null;
      const field = dialog.querySelector('input');
      const create = [...dialog.querySelectorAll('button')].find((button) => button.classList.contains('ui-button--primary'));
      const card = dialog.querySelector('.modal-card') || dialog;
      return { card: box(card.getBoundingClientRect()), field: box(field.getBoundingClientRect()), create: box(create.getBoundingClientRect()), value: field.value };
    },

    /** The open book's id, once the workspace shows it. */
    projectId() {
      const match = location.hash.match(/\/project\/([^/?#]+)/);
      return match ? match[1] : null;
    },

    /** Project Memory the author had told the Agent before (not on camera). */
    async remember({ body }) {
      const projectId = P.scenes.projectId();
      if (!projectId) throw new Error('No book is open');
      const { createMemory } = await import('/src/renderer/usecase/useAgentMemory.ts');
      await createMemory(projectId, { kind: 'directive', body, source: 'author', status: 'active' });
      return 'remembered';
    },

    /** The chapter's title field. */
    title() {
      const field = [...document.querySelectorAll('textarea.page__title')].find(visible);
      return field ? box(field.getBoundingClientRect()) : null;
    },

    titleValue() {
      const field = [...document.querySelectorAll('textarea.page__title')].find(visible);
      return field ? field.value : null;
    },

    async superView() {
      const { ui } = await stores();
      return ui.getState().activeSuperView;
    },

    async immersive() {
      const { ui } = await stores();
      return ui.getState().immersiveWriting;
    },

    /** The Agent's answer since the author's last message, as much of it as the panel shows. */
    reply() {
      const bubbles = [...document.querySelectorAll('.agt-user-bubble')].filter(visible);
      const last = bubbles[bubbles.length - 1];
      const composer = document.querySelector('.agt-composer');
      if (!last || !composer) return null;
      const scroll = scroller(last);
      const view = scroll ? scroll.getBoundingClientRect() : { top: 0, bottom: composer.getBoundingClientRect().top };
      const top = Math.max(last.getBoundingClientRect().bottom + 4, view.top);
      const answers = [...document.querySelectorAll('.agent-md, .agt-tool')].filter((element) => visible(element)
        && element.getBoundingClientRect().top >= last.getBoundingClientRect().bottom - 1);
      const bottom = Math.min(view.bottom, Math.max(top + 40, ...answers.map((element) => element.getBoundingClientRect().bottom)));
      const panel = composer.getBoundingClientRect();
      return { x: panel.x, y: top, width: panel.width, height: bottom - top, scrollable: scroll ? scroll.scrollHeight - scroll.clientHeight : 0 };
    },

    /** Whether the right sidebar's tab `label` is the one showing. */
    tabActive({ label }) {
      const tab = [...document.querySelectorAll('.rightbar-tab-tray button')].find((button) => button.getAttribute('aria-label') === label);
      return Boolean(tab && tab.getAttribute('aria-pressed') === 'true');
    },

    /** Folds the bottom timeline away (or back), off camera. */
    async timeline({ hidden }) {
      const { ui } = await stores();
      ui.getState().setBottomTimelineHidden(hidden);
      return hidden;
    },

    /** How far above the Agent panel's visible top its answer starts (negative: scrolled out of view). */
    replyTop() {
      const bubbles = [...document.querySelectorAll('.agt-user-bubble')].filter(visible);
      const last = bubbles[bubbles.length - 1];
      if (!last) return null;
      const scroll = scroller(last);
      const view = scroll ? scroll.getBoundingClientRect().top : 0;
      return { top: last.getBoundingClientRect().bottom - view };
    },

    /** The chapter's last block, to click into at its end. */
    endRect() {
      const root = editor();
      if (!root) return null;
      const blocks = root.querySelectorAll(':scope > *');
      const last = blocks[blocks.length - 1] || root;
      const rect = last.getBoundingClientRect();
      return { x: rect.x + Math.max(0, rect.width - 40), y: rect.y, width: 30, height: Math.max(rect.height, 20) };
    },

    /** An entity's hover card while it is open. */
    hoverCard() {
      const card = [...document.querySelectorAll('.hover-card-surface')].find(visible);
      return card ? box(card.getBoundingClientRect()) : null;
    },

    /** The element overview's card for `name` and its nearest neighbours, together. */
    cluster({ name, count }) {
      const cards = [...document.querySelectorAll('.se-card--free')].filter(visible)
        .map((element) => ({ text: element.textContent || '', rect: element.getBoundingClientRect() }));
      const centre = (rect) => [rect.left + rect.width / 2, rect.top + rect.height / 2];
      const anchor = cards.find((card) => card.text.includes(name)) || cards[0];
      if (!anchor) return null;
      const [ax, ay] = centre(anchor.rect);
      const near = cards.map((card) => ({ card, distance: Math.hypot(centre(card.rect)[0] - ax, centre(card.rect)[1] - ay) }))
        .sort((a, b) => a.distance - b.distance).slice(0, count + 1).map((entry) => entry.card.rect);
      const left = Math.min(...near.map((rect) => rect.left)), top = Math.min(...near.map((rect) => rect.top));
      const right = Math.max(...near.map((rect) => rect.right)), bottom = Math.max(...near.map((rect) => rect.bottom));
      return { x: left, y: top, width: right - left, height: bottom - top };
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
